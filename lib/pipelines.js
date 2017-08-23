"use strict";

const request = require('request'),
    _ = require('lodash'),
    async = require('async'),
    config = require('../config'),
    logger = require('./logger');


// OPTIMISATION: WE don't actually need to fetch all the data every time
// we can fetch the pipeline / jobs every minute and then just get the build
// statuses every 5 seconds.

// OPTMISATION - could replace this with a stream once we have acquired auth token and first pipeline data
// Then we can do something like :
// pipelines.pipe(get_version) <-- update pipeline with version
// pipelines.pipe(get_pipeline_tasks) <-- transforms pipeline into tasks
// pipelines.pipe(get_build_status) <-- update tasks with build status
// pipelines.pipe(determine_recent_builds) <-- update tasks with latest build info
// then do our pipeline ordering at the end


// return a singleton that handles pipelines
const doPipelines = function () {

    let that = {};

    // used to cache new versions for a short time
    that.pipelines = [];
    that.recentlyRunCache = [];

    that.token = {};

    that.get_pipelines = function (callback) {
        request({
            url: config.concourse_url + config.api_subdirectory + "/pipelines",
            headers: {
                cookie: 'ATC-Authorization=Bearer ' + that.token
            },
            json: true,
            strictSSL: false,
            timeout: config.http_request_timeout_seconds
        }, (error, response, body) => {
            if (!error && response.statusCode === 200) {
                that.pipelines = body;
                callback();
            } else {
                logger.error(`Could not get pipelines : ${error}`);
                return callback(error);
            }
        });
    };

    that.get_pipeline_statuses = function (done) {
        logger.info("Start updating all pipelines...");

        async.each(that.pipelines, function (pipeline, callback) {
            pipeline.buildSteps = [];
            const pipeline_name = pipeline.name;
            // if pipeline paused we don't care about it's status
            if (pipeline.paused) {
                pipeline.status = 'paused';
                return callback();
            }

            let jobUrl = config.concourse_url + config.api_subdirectory + pipeline.url + "/jobs";
            logger.debug(jobUrl);

            request({
                url: jobUrl,
                headers: {
                    cookie: 'ATC-Authorization=Bearer ' + that.token
                },
                json: true,
                strictSSL: false,
                timeout: config.http_request_timeout_seconds
            }, (error, response, body) => {
                logger.debug(`Response recevied from ${pipeline_name}`);
                logger.trace(response);
                if (!error && response.statusCode === 200) {

                    async.each(body, function (task, callback) {

                        if (task.finished_build !== undefined && task.finished_build !== null) {

                            const buildStep = task.finished_build;
                            buildStep.name = task.name;
                            buildStep.id = task.id;

                            buildStep.url = jobUrl + "/" + buildStep.name + "/builds";
                            buildStep.ofPipeline = pipeline;

                            pipeline.buildSteps.push(buildStep);

                            // record start and end times for pipeline sorting
                            // as multiple jobs can run for one pipeline we take
                            // the earliest start time and the latest end time.
                            let taskStartTime = task.finished_build.start_time;
                            if (!pipeline.start_time || taskStartTime < pipeline.start_time) {
                                pipeline.start_time = taskStartTime;
                            }
                            let taskEndTime = task.finished_build.end_time;
                            if (!pipeline.end_time || taskEndTime > pipeline.end_time) {
                                pipeline.end_time = taskEndTime;
                            }

                            if (pipeline["status"] === undefined || pipeline["status"] === "succeeded") {
                                pipeline["status"] = task.finished_build.status;
                            }

                            if (pipeline.paused) {
                                buildStep.status = 'paused';
                                // no need to get latest status of a paused build
                                return callback();
                            } else {
                                // see if any builds are in progress
                                // REVIEW: any way to optimise this so it's not being called so often ?
                                that.get_latest_build_status(buildStep, callback);
                            }
                        } else {
                            logger.info(`Task ${task.name} of pipeline ${pipeline_name} is not reporting any finished builds`);
                            return callback();
                        }

                    }, function (err) {
                        return callback(err);
                    });

                } else {
                    logger.warn(`Failed call to ${jobUrl} : ${error}`);
                    // no further work to do
                    return callback(error);
                }
            });
        }, function (err) {
            done(err);
        });
    };

    that.get_latest_build_status = function (buildStep, callback) {

        const buildStepUrl = buildStep.url;
        logger.debug(buildStepUrl);
        request({
                url: buildStepUrl,
                headers: {
                    cookie: 'ATC-Authorization=Bearer ' + that.token
                },
                json: true,
                strictSSL: false,
                timeout: config.http_request_timeout_seconds
            }, (error, response, body) => {
                logger.debug(`Response recevied from ${buildStep.name} of pipeline ${buildStep.ofPipeline.name}`);
                if (!error && response.statusCode === 200) {
                    logger.trace(body);
                    // only update builds that are not part of a paused pipeline
                    // only use the last build
                    if (buildStep.ofPipeline.status !== 'paused') {
                        // REVIEW: we can determine overall build health here by analysing all the build statuses rather than just the
                        // first
                        buildStep.status = body[0].status;
                    }
                }
                return callback();
            }
        );
    };

    that.orderPipeline = function (callback) {
        // sort by start time descending
        // ie latest build moves to front
        that.pipelines.sort((a, b) => {
            return b.end_time - a.end_time;
        });

        let maxSize = config.maxAllowedPipelines;
        let size = 0;
        for (let index = 0; index < that.pipelines.length - 1; index++) {
            if (size > maxSize) {
                that.pipelines[index].display = 'hide';
                continue;
            }
            if (that.pipelines[index].paused) {
                that.pipelines[index].display = 'hide';
            } else {
                that.pipelines[index].display = 'show';
                size++;
            }

            that.pipelines[index].buildSteps.sort((a, b) => {
                return a.id - b.id;
            });
        }

        return callback();
    };

    that.determine_recent_builds = function (callback) {
        for (let pipeline of that.pipelines) {
            // look in cache
            let recentlyRun = that.recentlyRunCache[pipeline.name];
            if (!recentlyRun) {
                recentlyRun = {};
            }
            if (recentlyRun.end_time !== pipeline.end_time) {
                logger.info(`Pipeline  ${pipeline.name} has recently finished`);
                recentlyRun.end_time = pipeline.end_time;
                that.recentlyRunCache[pipeline.name] = recentlyRun;
                pipeline.finished_recently = true;
            }
        }
        return callback();

    };

    return {
        getPipelinesAsync: function (token, done) {
            that.token = token;

            async.series([
                    that.get_pipelines,
                    that.get_pipeline_statuses,
                    that.determine_recent_builds,
                    that.orderPipeline,
                ],
                function (err) {
                    if (err) {
                        logger.warn('Error while processing at least one pipeline');
                    } else {
                        logger.info('All pipelines have been processed');
                    }
                    done(err, that.pipelines);
                }
            );
        },
        getPipelineCache: function () {
            return that.pipelines;
        }
    };

}();

module.exports = doPipelines;