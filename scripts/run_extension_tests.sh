#!/bin/bash

set -eu

export HasVs=false
export CMT_TESTING=1

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname $(dirname $(realpath "$0")))
else
	ROOT=$(dirname $(dirname $(readlink -f $0)))
fi

pushd $ROOT

# Run all tests with a workspace folder where no CMakeLists.txt exists
# This prevents automatic loading of the extension.

TESTS=(
	without-cmakelist-file
	successful-build
	vs-preferred-gen  # Skipped on non-Windows, but listed here for completeness.
)
for testname in ${TESTS[@]}; do
	env \
		CODE_TESTS_PATH=$ROOT/out/test/extension-tests/$testname \
		CODE_TESTS_WORKSPACE=$ROOT/test/extension-tests/$testname/project-folder \
		node ./node_modules/vscode/bin/test
done

popd
