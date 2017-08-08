"use strict"

var AWS = require('aws-sdk'),
    s3 = new AWS.S3({apiVersion: '2006-03-01', httpOptions: {timeout: 5000}}),
    config = require('../config');

AWS.config.loadFromPath('./s3_config.json');

// return a singleton that handles versioning
var doVersions = function () {

    var that = {};

    // used to cache new versions for a short time
    that.versionCache = [];

    that.calculateIfVersionIsStillNew = function (pipeline) {

        let foundVersion = that.versionCache[pipeline.name];
        if (foundVersion) {
            // if version not changed for a while then blank the newversion tag
            // otherwise keep it
            let aWhileInMilliseconds = config.notify_new_versions_for_minutes * 60 * 1000;
            if (new Date().getTime() - foundVersion.updated.getTime() > aWhileInMilliseconds) {
                if (config.debug) {
                    console.log(pipeline.version + " version hasn't changed for a while so tell the pipeline");
                }
                pipeline.newversion = '';
            } else {
                if (config.debug) {
                    console.log(pipeline.name + " version is still new")
                }
                pipeline.newversion = 'newversion';
            }
        }
    };

    that.recordFirstPipelineVersion = function (versionData, pipeline) {
        console.log("first time a version recorded for pipeline " + pipeline.name);
        that.versionCache[pipeline.name] = {
            version: versionData,
            updated: new Date('1970-01-01')
        };
        pipeline.newversion = ''
    };

    that.recordUpdatedPipelineVersion = function (versionData, pipeline) {
        let foundVersion = that.versionCache[pipeline.name];
        if (foundVersion) {
            console.log("tell the pipeline we have a new version");
            foundVersion.version = versionData;
            foundVersion.updated = new Date();

            pipeline.newversion = 'newversion';
        }
    };

    that.handleVersion = function (versionData, pipeline) {
        pipeline.buildVersion = versionData;

        // if a new version found then let the UI know
        let foundVersion = that.versionCache[pipeline.name];
        if (foundVersion) {
            // if version changed then update it
            if (foundVersion.version !== versionData) {
                that.recordUpdatedPipelineVersion(versionData, pipeline);
            } else {
                that.calculateIfVersionIsStillNew(pipeline);
            }
        } else {
            that.recordFirstPipelineVersion(versionData, pipeline);
        }
    };

    that.handleSameVersion = function (pipeline) {
        let foundVersion = that.versionCache[pipeline.name];
        if (foundVersion) {
            pipeline.buildVersion = foundVersion.version;
            that.calculateIfVersionIsStillNew(pipeline);
        }
    };

    that.recordNoVersionFound = function (pipeline) {
        // if it fails or the bucket doesn't exist then ignore the build version
        pipeline.buildVersion = '';
        that.versionCache[pipeline.name] = {
            version: '',
            updated: new Date('1970-01-01')
        };
    };

    return {
        // TODO: use async to tidy this up and
        // remove the need to use count to manage callbacks
        fetchVersions: function (pipelines, callback) {
            let count = 0;
            // need to do this adjustment here otherwise if we change count whilst
            // requests are in flight we create a race condition
            for (pipeline of pipelines) {
                // don't waste time looking for versions of paused builds
                if (pipeline.paused) {
                    pipeline.skipVersion = true;
                    count++;
                    // console.log("count is now " + count);
                } else if (!pipeline.finished_recently) {
                    // if we already have the version in the cache then use it if the build hasn't
                    // recently finished.
                    that.handleSameVersion(pipeline);
                    pipeline.skipVersion = true;
                    count++;
                    // console.log("count is now " + count);
                }

                if (count === pipelines.length) {
                    console.log("counted all pipeline versions");
                    return callback();
                }
            }
            if (config.debug) {
                console.log("number of pipelines to look at " + pipelines.length);
            }

            for (pipeline of pipelines) {

                if (pipeline.skipVersion) {
                    //console.log("skipping - count is now " + count);
                    continue;
                }

                const currentPipeline = pipeline;

                const bucket = config.versions_bucket;
                const key = decodeURIComponent(currentPipeline.name + "/version.txt".replace(/\+/g, ' '));
                const params = {
                    Bucket: bucket,
                    Key: key,
                };
                s3.getObject(params, (err, data) => {

                    if (err) {
                        console.log("failed to get version for " + key, err.message);
                        that.recordNoVersionFound(currentPipeline);
                    } else {
                        console.log("Fetching version from S3 for " + currentPipeline.name);

                        let objectData = data.Body.toString('utf-8');
                        that.handleVersion(objectData, currentPipeline);
                    }
                    count++;
                    if (config.debug) {
                        console.log(count + " of " + pipelines.length - 1 + " with " + currentPipeline.name);
                    }
                    if (count === pipelines.length) {
                        console.log("counted all pipeline versions");
                        return callback();
                    }
                });
            }
        }
    }
}();

module.exports = doVersions;