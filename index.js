var express = require('express');
var bodyParser = require('body-parser');
var config = require('./config');
var request = require('request');
var _ = require('lodash');
var async = require('async');
var basicAuth = require('express-basic-auth');
var doVersions = require('./lib/versions');


var app = express();

app.set('port', (process.env.PORT || 8080));
app.set('views', __dirname + '/views');
app.set('view engine', 'pug');
app.use(express.static(__dirname + '/resources'));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());
if (config.enable_basic_auth) {
    dashboard_user = {}
    dashboard_user[config.basic_auth_user] = config.basic_auth_password
    app.use(basicAuth({
        users: dashboard_user,
        challenge: true,
        realm: "concourse-dashboard"
    }))
}

var pipelines;
var recentlyRunCache = [];
var token;
var buildStepsCache = [];
var stepCount = 0;


// OPTIMISATION: WE don't actually need to fetch all the data every time
// we can fetch the pipeline / jobs every minute and then just get the build
// statuses every 5 seconds.
get_bearer = (callback) => {
    console.log("get bearer token...");
    request({
        url: config.concourse_url + config.api_subdirectory + "/teams/" + config.concourse_team + "/auth/token",
        auth: {
            username: config.concourse_username,
            password: config.concourse_password
        },
        json: true,
        strictSSL: false
    }, (error, response, body) => {
        if (!error && response.statusCode === 200) {
            token = body.value;
            callback();
        } else {
            console.log(error);
            callback(error);
        }
    });
};

get_pipelines = (callback) => {
    request({
        url: config.concourse_url + config.api_subdirectory + "/pipelines",
        headers: {
            cookie: 'ATC-Authorization=Bearer ' + token
        },
        json: true,
        strictSSL: false
    }, (error, response, body) => {
        if (!error && response.statusCode === 200) {
            pipelines = body;
            callback();
        } else {
            console.log("could not get pipelines " + error);
            callback();
        }
    });
};

get_pipeline_statuses = (callback) => {
    let count = 0;
    // reset cache of build steps
    buildStepsCache = [];
    stepCount = 0;
    console.log("start all pipelines");
    for (pipeline of pipelines) {

        pipeline.buildSteps = [];

        // if pipeline paused we don't care about it's status
        if (pipeline.paused) {
            pipeline.status = 'paused';
            count++;
            continue;
        }

        let jobUrl = config.concourse_url + config.api_subdirectory + pipeline.url + "/jobs";
        if (config.debug) {
            console.log(jobUrl);
        }
        request({
            url: jobUrl,
            headers: {
                cookie: 'ATC-Authorization=Bearer ' + token
            },
            json: true,
            strictSSL: false
        }, (error, response, body) => {
            if (!error && response.statusCode === 200) {
                for (task of body) {

                    if (task.finished_build !== undefined && task.finished_build !== null) {
                        let index = _.findIndex(pipelines, {'name': task.finished_build.pipeline_name});

                        let buildStep = task.finished_build;
                        buildStep.name = task.name;

                        let currentPipeline = pipelines[index];

                        buildStep.url = jobUrl + "/" + buildStep.name + "/builds";
                        buildStep.ofPipeline = currentPipeline;

                        currentPipeline.buildSteps.push(buildStep);

                        // index the build steps and keep track of how many there are
                        buildStepsCache[buildStep.id] = buildStep;
                        stepCount++;

                        // record start and end times for pipeline sorting
                        // as multiple jobs can run for one pipeline we take
                        // the earliest start time and the latest end time.
                        let taskStartTime = task.finished_build.start_time;
                        if (!currentPipeline.start_time || taskStartTime < currentPipeline.start_time) {
                            currentPipeline.start_time = taskStartTime;
                        }
                        let taskEndTime = task.finished_build.end_time;
                        if (!currentPipeline.end_time || taskEndTime > currentPipeline.end_time) {
                            currentPipeline.end_time = taskEndTime;
                        }

                        if (currentPipeline.paused) {
                            buildStep.status = 'paused'
                        }

                        if (currentPipeline["status"] === undefined || currentPipeline["status"] === "succeeded") {
                            currentPipeline["status"] = task.finished_build.status;
                        }
                    }
                }
            } else {
                console.log(error);
            }

            if (count === pipelines.length - 1) {
                console.log("counted all pipelines");
                callback();
            } else {
                count++;
            }
        });
    }

};

orderPipeline = (callback) => {
    // sort by start time descending
    // ie latest build moves to front
    pipelines.sort((a, b) => {
        return b.end_time - a.end_time;
    });

    let maxSize = config.maxAllowedPipelines;
    let size = 0;
    for (let index = 0; index < pipelines.length - 1; index++) {
        if (size > maxSize) {
            pipelines[index].display = 'hide';
            continue;
        }
        if (pipelines[index].paused) {
            // console.log("pipeline " + pipelines[index].name + " paused : " + pipelines[index].paused);
            pipelines[index].display = 'hide';
        } else {
            pipelines[index].display = 'show';
            size++;
        }

        // sort build steps by start time ascending
        pipelines[index].buildSteps.sort((a, b) => {
            return a.start_time - b.start_time;
        });
    }

    callback();
};

determine_recent_builds = (callback) => {
    for (pipeline of pipelines) {
        // look in cache
        let recentlyRun = recentlyRunCache[pipeline.name];
        if (!recentlyRun) {
            recentlyRun = {};
        }
        // console.log(recentlyRun.end_time);
        // console.log(currentPipeline.end_time);
        if (recentlyRun.end_time !== pipeline.end_time) {
            console.log("pipeline " + pipeline.name + " has recently finished");
            recentlyRun.end_time = pipeline.end_time;
            recentlyRunCache[pipeline.name] = recentlyRun;
            pipeline.finished_recently = true;
        }
    }
    callback();

};

get_build_statuses = (callback) => {
    let count = 0;
    if (config.debug) {
        console.log("How many steps " + stepCount);
    }
    for (let index in buildStepsCache) {
        let buildStep = buildStepsCache[index];
        request({
                url: buildStep.url,
                headers: {
                    cookie: 'ATC-Authorization=Bearer ' + token
                },
                json: true,
                strictSSL: false
            }, (error, response, body) => {
                if (!error && response.statusCode === 200) {

                    // only update builds that are not part of a paused pipeline
                    // only use the last build
                    if (buildStep.ofPipeline.status !== 'paused') {
                        buildStep.status = body[0].status;
                        //console.log("step " + buildStep.id + " is " + buildStep.status);
                    }
                }
                if (count === stepCount - 1) {
                    console.log("counted all steps");
                    callback();
                } else {
                    count++;
                }
            }
        )
    }
};

getVersions = (callback) => {
    if (config.enableVersions) {
        doVersions.fetchVersionsAsync(pipelines, callback);
    } else {
        callback();
    }
};

ensureAuth = (callback) => {
    if (config.use_bearer_token) {
        get_bearer(callback);
    } else {
        callback();
    }
};

doRenderResults = (res) => {
    return function (err) {
        if (err) {
            res.end(JSON.stringify(err));
        } else {
            res.render('overview', {config: config, pipelines: pipelines})
        }
    }
};

let lastUpdate;
let startTime;

app.get('/', (req, res) => {
    startTime = new Date().getTime();
    let renderResults = doRenderResults(res);

    let refreshInMilliseconds = config.refresh_in_seconds * 1000;
    if (lastUpdate && new Date().getTime() - lastUpdate.getTime() < refreshInMilliseconds) {
        console.log("Skipping data refresh...");
        return renderResults();
    }
    async.series([
            ensureAuth,
            get_pipelines,
            get_pipeline_statuses,
            get_build_statuses,
            determine_recent_builds,
            orderPipeline,
            getVersions
        ],
        function (err) {
            if (!err) {
                console.log((new Date().getTime() - startTime) / 1000 + " seconds");
                lastUpdate = new Date();
            }
            renderResults(err);
        }
    )
});

app.listen(app.get('port'), () => {
    console.log('running on port', app.get('port'));
});
