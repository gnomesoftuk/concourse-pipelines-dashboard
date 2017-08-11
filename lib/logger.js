'use strict';
const config = require('../config');

const simpleNodeLogger = require('simple-node-logger'),
    opts = {
        timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS'
    },
    logger = simpleNodeLogger.createSimpleLogger(opts);
    logger.setLevel(config.log_level);
console.log("created logger");
module.exports = logger;
