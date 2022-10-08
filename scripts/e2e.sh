#!/usr/bin/env bash

export CODE_TESTS_PATH="$(pwd)/vscode-client/out/test"
export CODE_TESTS_WORKSPACE="$(pwd)/vscode-client/testFixture"

node "$(pwd)/vscode-client/out/test/runTest"
