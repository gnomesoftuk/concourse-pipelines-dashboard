var express = require('express');
var bodyParser = require('body-parser');
var config = require('./config')
var request = require('request')
var _ = require('lodash');
var async = require('async')
var basicAuth = require('express-basic-auth')

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
var token;
var allBuildSteps = [];
var stepCount = 0;


// OPTIMISATION: WE don't actually need to fetch all the data every time
// we can fetch the pipeline / jobs every minute and then just get the build
// statuses every 5 seconds.
get_bearer = (callback) => {
    //console.log("get bearer token...");
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
        }
    });
}
// TODO: as something is building I want to see the current step pop inside the current one
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
}

get_pipeline_statuses = (callback) => {
    let count = 0;
    // reset cache of build steps
    allBuildSteps = [];
    stepCount = 0;
    for (pipeline of pipelines) {

        // if pipeline paused we don't care about it's status
        if (pipeline.paused) {
            pipeline.status = 'paused';
        }

        pipeline.buildSteps = [];
        let jobUrl = config.concourse_url + config.api_subdirectory + pipeline.url + "/jobs";
        console.log(jobUrl);
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
                        if (currentPipeline.paused) {
                            buildStep.status = 'paused'
                        }
                        buildStep.url = jobUrl + "/" + buildStep.name + "/builds";
                        buildStep.ofPipeline = currentPipeline;
                        currentPipeline.buildSteps.push(buildStep);

                        // index the build steps and keep track of how many there are
                        allBuildSteps[buildStep.id] = buildStep;
                        stepCount++;

                        // record start time for sorting
                        currentPipeline.start_time = task.finished_build.start_time;

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

}

function orderPipeline(callback) {
    // sort by start time descending
    // ie latest build moves to front
    pipelines.sort((a, b) => {
        return b.start_time - a.start_time;
    });

    let maxSize = 16;
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
    }

    callback();
}

function get_build_statuses(callback) {
    let count = 0;

    console.log("How many steps " + stepCount);
    for (let index in allBuildSteps) {
        console.log(index);
        let buildStep = allBuildSteps[index];
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
                        console.log("step " + buildStep.id + " is " + buildStep.status);
                        // console.log(JSON.stringify(body));
                    }
                }
                if (count === stepCount -1) {
                    console.log("counted all steps");
                    callback();
                } else {
                    count++;
                }
            }
        )
    }
}

app.get('/', (req, res) => {
    async.series([
            function (callback) {
                if (config.use_bearer_token) {
                    get_bearer(callback);
                } else {
                    callback();
                }
            },
            get_pipelines,
            get_pipeline_statuses,
            get_build_statuses,
            orderPipeline
        ],
        function (err, result) {
            if (err) {
                res.end(JSON.stringify(err));
            } else {
                res.render('overview', {config: config, pipelines: pipelines})
            }
        }
    )
});

app.listen(app.get('port'), () => {
    console.log('running on port', app.get('port'));
});
