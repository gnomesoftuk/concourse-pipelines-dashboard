const config = {};
config.concourse_url = process.env.CONCOURSE_URL || "https://ci.concourse.ci"; //Replace with your concourse url
config.api_subdirectory = "/api/v1";
config.use_bearer_token= process.env.CONCOURSE_USE_BEARER || true;
config.enable_basic_auth = process.env.CONCOURSE_ENABLE_BASIC_AUTH || true;
config.basic_auth_user = process.env.CONCOURSE_BASIC_AUTH_USER || "admin";
config.basic_auth_password = process.env.CONCOURSE_BASIC_AUTH_PASSWORD || "password";
config.http_request_timeout = process.env.HTTP_REQUEST_TIMEOUT || 10000;

config.concourse_team= process.env.CONCOURSE_TEAM || "main";
config.concourse_username = process.env.CONCOURSE_USERNAME || "user";
config.concourse_password = process.env.CONCOURSE_PASSWORD || "password";
config.maxAllowedPipelines = 50;

config.enableVersions = process.env.ENABLE_VERSIONS || false;
config.versions_bucket = process.env.S3_VERSIONS_BUCKET || "s3-versions-bucket";
config.refresh_in_seconds = process.env.REFRESH_SECONDS || 10;
config.notify_new_versions_for_minutes = process.env.NOTIFY_NEW_VERSIONS_FOR_MINS || 15;
config.log_level = process.env.LOG_LEVEL || "trace";

module.exports = config;
