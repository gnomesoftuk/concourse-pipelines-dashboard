#!/usr/bin/env bash

# build the image
docker build -t gnomesoft/concourse-pipelines-dashboard:latest .

docker tag gnomesoft/concourse-pipelines-dashboard MyDockerRepo/gnomesoft/concourse-pipelines-dashboard

echo "push using :"
echo "docker push MyDockerRepo/gnomesoft/concourse-pipelines-dashboard"
