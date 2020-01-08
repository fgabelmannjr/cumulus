#!/bin/bash
set -ex
. ./bamboo/abort-if-not-pr.sh

  # If flag is set, use container-cached bootstrap env
 if [[ $USE_CACHED_BOOTSTRAP == true ]]; then
    echo "*** Using cached bootstrap"
    cd /cumulus/
 fi

npm run lint-md
npm run lint