"use strict";

const request = require('request'),
    _ = require('lodash'),
    async = require('async'),
    config = require('../config');


// OPTIMISATION: WE don't actually need to fetch all the data every time
// we can fetch the pipeline / jobs every minute and then just get the build
// statuses every 5 seconds.

// return a singleton that handles pipelines
const doPipelines = function () {

    let that = {};

    // used to cache new versions for a short time
    that.pipelines = [];
    that.recentlyRunCache = [];
    that.buildStepsCache = [];
    that.stepCount = 0;

    that.token = {};

    that.get_pipelines = function (callback) {
        request({
            url: config.concourse_url + config.api_subdirectory + "/pipelines",
            headers: {
                cookie: 'ATC-Authorization=Bearer ' + that.token
            },
            json: true,
            strictSSL: false
        }, (error, response, body) => {
            if (!error && response.statusCode === 200) {
                that.pipelines = body;
                callback();
            } else {
                console.log("could not get pipelines " + error);
                callback();
            }
        });
    };

    that.get_pipeline_statuses = function (callback) {
        let count = 0;
        // reset cache of build steps
        that.buildStepsCache = [];
        that.stepCount = 0;
        console.log("start all pipelines");
        for (let pipeline of that.pipelines) {

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
                    cookie: 'ATC-Authorization=Bearer ' + that.token
                },
                json: true,
                strictSSL: false
            }, (error, response, body) => {
                if (!error && response.statusCode === 200) {
                    for (let task of body) {

                        if (task.finished_build !== undefined && task.finished_build !== null) {
                            let index = _.findIndex(that.pipelines, {'name': task.finished_build.pipeline_name});

                            let buildStep = task.finished_build;
                            buildStep.name = task.name;

                            let currentPipeline = that.pipelines[index];

                            buildStep.url = jobUrl + "/" + buildStep.name + "/builds";
                            buildStep.ofPipeline = currentPipeline;

                            currentPipeline.buildSteps.push(buildStep);

                            // index the build steps and keep track of how many there are
                            that.buildStepsCache[buildStep.id] = buildStep;
                            that.stepCount++;

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

                if (count === that.pipelines.length - 1) {
                    console.log("counted all pipelines");
                    callback();
                } else {
                    count++;
                }
            });
        }

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
                // console.log("pipeline " + pipelines[index].name + " paused : " + pipelines[index].paused);
                that.pipelines[index].display = 'hide';
            } else {
                that.pipelines[index].display = 'show';
                size++;
            }

            // sort build steps by start time ascending
            that.pipelines[index].buildSteps.sort((a, b) => {
                return a.start_time - b.start_time;
            });
        }

        callback();
    };

    that.determine_recent_builds = function (callback) {
        for (let pipeline of that.pipelines) {
            // look in cache
            let recentlyRun = that.recentlyRunCache[pipeline.name];
            if (!recentlyRun) {
                recentlyRun = {};
            }
            // console.log(recentlyRun.end_time);
            // console.log(currentPipeline.end_time);
            if (recentlyRun.end_time !== pipeline.end_time) {
                console.log("pipeline " + pipeline.name + " has recently finished");
                recentlyRun.end_time = pipeline.end_time;
                that.recentlyRunCache[pipeline.name] = recentlyRun;
                pipeline.finished_recently = true;
            }
        }
        callback();

    };

    that.get_build_statuses = function (callback) {
        let count = 0;
        if (config.debug) {
            console.log("How many steps " + that.stepCount);
        }
        for (let index in that.buildStepsCache) {
            let buildStep = that.buildStepsCache[index];
            request({
                    url: buildStep.url,
                    headers: {
                        cookie: 'ATC-Authorization=Bearer ' + that.token
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
                    if (count === that.stepCount - 1) {
                        console.log("counted all steps");
                        callback();
                    } else {
                        count++;
                    }
                }
            )
        }
    };

    return {
        getPipelinesAsync: function (token, done) {
            that.token = token;

            async.series([
                    that.get_pipelines,
                    that.get_pipeline_statuses,
                    that.get_build_statuses,
                    that.determine_recent_builds,
                    that.orderPipeline,
                ],
                function (err) {
                    if (err) {
                        // One of the iterations produced an error.
                        // All processing will now stop.
                        console.log('Error while processing at least one pipeline');
                    } else {
                        if (config.debug) {
                            console.log('All pipelines have been processed');
                        }
                    }
                    done(err, that.pipelines)
                }
            )
        },
        getPipelineCache: function () {
            return that.pipelines;
        }
    }

}();

module.exports = doPipelines;