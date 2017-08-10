const express = require('express'),
    bodyParser = require('body-parser'),
    config = require('./config'),
    request = require('request'),
    _ = require('lodash'),
    async = require('async'),
    basicAuth = require('express-basic-auth'),
    doVersions = require('./lib/versions'),
    doPipelines = require('./lib/pipelines');


const app = express();

app.set('port', (process.env.PORT || 8080));
app.set('views', __dirname + '/views');
app.set('view engine', 'pug');
app.use(express.static(__dirname + '/resources'));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());
if (config.enable_basic_auth) {
    dashboard_user = {};
    dashboard_user[config.basic_auth_user] = config.basic_auth_password
    app.use(basicAuth({
        users: dashboard_user,
        challenge: true,
        realm: "concourse-dashboard"
    }))
}
const get_bearer = (callback) => {

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
            let token = body.value;
            callback(null, token);
        } else {
            console.log(error);
            callback(error);
        }
    });
};

const ensureAuth = (callback) => {
    if (config.use_bearer_token) {
        get_bearer(callback);
    } else {
        callback();
    }
};

const doRenderResults = (res) => {
    return function (err, pipelines) {
        if (err) {
            res.end(JSON.stringify(err));
        } else {
            res.render('overview', {config: config, pipelines: pipelines})
        }
    };
};

let lastUpdate;
let startTime;

app.get('/', (req, res) => {
    startTime = new Date().getTime();
    let renderResults = doRenderResults(res);

    let refreshInMilliseconds = config.refresh_in_seconds * 1000;
    if (lastUpdate && new Date().getTime() - lastUpdate.getTime() < refreshInMilliseconds) {
        console.log("Skipping data refresh...");
        return renderResults(null, doPipelines.getPipelineCache());
    }

    async.waterfall([
            ensureAuth,
            doPipelines.getPipelinesAsync,
            doVersions.fetchVersionsAsync
        ],
        function (err, pipelines) {
            if (!err) {
                console.log((new Date().getTime() - startTime) / 1000 + " seconds");
                lastUpdate = new Date();
            }
            renderResults(err, pipelines);
        }
    )
});

app.listen(app.get('port'), () => {
    console.log('running on port', app.get('port'));
});
