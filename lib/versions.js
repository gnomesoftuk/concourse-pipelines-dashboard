"use strict";

const AWS = require('aws-sdk'),
    config = require('../config'),
    async = require('async'),
    logger = require('./logger'),
    s3 = new AWS.S3({
            apiVersion: '2006-03-01',
            sslEnabled: true,
            httpOptions: {timeout: config.http_request_timeout_seconds}
        }
    );

AWS.config.loadFromPath('./s3_config.json');

// return a singleton that handles versioning
const doVersions = function () {

    let that = {};

    // used to cache new versions for a short time
    that.versionCache = [];
    that.initialisedVersionCache = false;

    that.calculateIfVersionIsStillNew = function (pipeline) {

        let foundVersion = that.versionCache[pipeline.name];
        if (foundVersion) {
            // if version not changed for a while then blank the newversion tag
            // otherwise keep it
            let aWhileInMilliseconds = config.notify_new_versions_for_minutes * 60 * 1000;
            if (new Date().getTime() - foundVersion.updated.getTime() > aWhileInMilliseconds) {
                logger.debug(pipeline.name + " version hasn't changed for a while so tell the pipeline");
                pipeline.newversion = '';
            } else {
                logger.debug(pipeline.name + " version is still new");

                pipeline.newversion = 'newversion';
            }
        }
    };

    that.recordFirstPipelineVersion = function (versionData, pipeline) {
        logger.info("first time a version recorded for pipeline " + pipeline.name);
        that.versionCache[pipeline.name] = {
            version: versionData,
            updated: new Date('1970-01-01')
        };
        pipeline.newversion = ''
    };

    that.recordUpdatedPipelineVersion = function (versionData, pipeline) {
        let foundVersion = that.versionCache[pipeline.name];
        if (foundVersion) {
            logger.info("tell the pipeline we have a new version");
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
        fetchVersionsAsync: function (pipelines, done) {

            if (!config.enableVersions) {
                return done(null, pipelines);
            }

            const bucket = config.versions_bucket;
            logger.debug("number of pipelines to look at " + pipelines.length);

            async.each(pipelines, function (pipeline, callback) {
                    if (pipeline.paused) {
                        //avoid callback overflow with large number of pipelines
                        return async.setImmediate(function () {
                            pipeline.skipVersion = true;
                            logger.debug("skipping version on " + pipeline.name);

                            return callback();
                        });
                    } else if (!pipeline.finished_recently && that.initialisedVersionCache) {
                        //avoid callback overflow with large number of pipelines
                        return async.setImmediate(function () {
                            that.handleSameVersion(pipeline);
                            pipeline.skipVersion = true;
                            logger.debug("skipping version on " + pipeline.name);

                            return callback();
                        });
                    }

                    const key = decodeURIComponent(pipeline.name + "/version.txt".replace(/\+/g, ' '));
                    const params = {
                        Bucket: bucket,
                        Key: key,
                    };
                    s3.getObject(params, (err, data) => {

                        if (err) {
                            logger.warn("failed to get version for " + key, err.message);
                            that.recordNoVersionFound(pipeline);
                        } else {
                            logger.info("Fetching version from S3 for " + pipeline.name);

                            let objectData = data.Body.toString('utf-8');
                            that.handleVersion(objectData, pipeline);
                        }
                        return callback();
                    });
                },
                function (err) {
                    // if any of the file processing produced an error, err would equal that error
                    if (err) {
                        // One of the iterations produced an error.
                        // All processing will now stop.
                        logger.warn('Error while processing at least one version');
                    } else {
                        logger.info('All versions have been processed');
                    }
                    that.initialisedVersionCache = true;
                    done(err, pipelines);
                }
            );
        }
    };
}();

module.exports = doVersions;