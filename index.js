const express = require('express'),
    bodyParser = require('body-parser'),
    config = require('./config'),
    request = require('request'),
    _ = require('lodash'),
    async = require('async'),
    timeout = require('connect-timeout'),
    basicAuth = require('express-basic-auth'),
    doVersions = require('./lib/versions'),
    doPipelines = require('./lib/pipelines'),
    logger = require('./lib/logger');


const app = express();

app.set('port', (process.env.PORT || 8080));
app.set('views', __dirname + '/views');
app.set('view engine', 'pug');
app.use(express.static(__dirname + '/resources'));
app.use(bodyParser.urlencoded({extended: false}));
app.use(timeout(config.server_timeout_seconds + 's'));
app.use(bodyParser.json());
app.use(haltOnTimedout);

let dashboard_user;
if (config.enable_basic_auth) {
    dashboard_user = {};
    dashboard_user[config.basic_auth_user] = config.basic_auth_password;
    app.use(basicAuth({
        users: dashboard_user,
        challenge: true,
        realm: "concourse-dashboard"
    }));
}
const get_bearer = (callback) => {

    logger.info("get bearer token...");
    request({
        url: config.concourse_url + config.api_subdirectory + "/teams/" + config.concourse_team + "/auth/token",
        auth: {
            username: config.concourse_username,
            password: config.concourse_password
        },
        json: true,
        strictSSL: false,
        timeout: config.http_request_timeout_seconds
    }, (error, response, body) => {
        if (!error && response.statusCode === 200) {
            let token = body.value;
            callback(null, token);
        } else {
            logger.debug(error);
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
        let errors;
        if (err) {
            errors = {message: JSON.stringify(err)};
            if (!pipelines) {
                pipelines = [];
            }
        } else {
            errors = {display: 'hide'};
        }
        res.render('overview', {errors: errors, config: config, pipelines: pipelines});
    };
};

function haltOnTimedout(req, res, next) {
    let renderResults = doRenderResults(res);
    req.on('timeout', function () {
        logger.error("timeout after " + config.server_timeout_seconds + " seconds");
        let errors = 'Sadly the request timed out after ' + config.server_timeout_seconds + ' seconds...';
        renderResults(errors, doPipelines.getPipelineCache());
    });
    next();
}

let lastUpdate;
let startTime;

app.get('/', (req, res) => {
    startTime = new Date().getTime();
    let renderResults = doRenderResults(res);

    let refreshInMilliseconds = config.refresh_pipeline_in_seconds * 1000;
    if (lastUpdate && new Date().getTime() - lastUpdate.getTime() < refreshInMilliseconds) {
        logger.info("Skipping data refresh...");
        if (req.timedout) {
            logger.warn("Request already timed out - skip rendering");
            return;
        }
        return renderResults(null, doPipelines.getPipelineCache());

    }

    async.waterfall([
            ensureAuth,
            doPipelines.getPipelinesAsync,
            doVersions.fetchVersionsAsync
        ],
        function (err, pipelines) {
            if (!err) {
                logger.info((new Date().getTime() - startTime) / 1000 + " seconds");
                lastUpdate = new Date();
            }
            // don't bother sending response if it has already timed out
            if (req.timedout) {
                logger.warn("Request already timed out - skip rendering");
                return;
            }
            renderResults(err, pipelines);

        }
    );
});

app.listen(app.get('port'), () => {
    logger.info('running on port ', app.get('port'));
});
