# Fetch exactly one commit of a git repository, with no history.
#
#   cmake -DREPO=<url> -DCOMMIT=<full hash> -DDEST=<dir> -P ShallowFetchCommit.cmake
#
# Why this exists: FetchContent's GIT_SHALLOW only works when GIT_TAG names a
# branch or tag. Given a commit hash it clones the tip of every branch and then
# fails to check the commit out unless it happens to be a branch tip. Without
# GIT_SHALLOW it clones all history, which for Tracktion Engine is 1.7 GB.
# GitHub serves any commit by hash, so `git fetch --depth 1 origin <hash>` gets
# just what we need (about 40 MB for Tracktion Engine).

foreach(var REPO COMMIT DEST)
    if(NOT DEFINED ${var} OR "${${var}}" STREQUAL "")
        message(FATAL_ERROR "ShallowFetchCommit.cmake: ${var} is required")
    endif()
endforeach()

string(LENGTH "${COMMIT}" commit_length)
if(NOT commit_length EQUAL 40 OR NOT COMMIT MATCHES "^[0-9a-f]+$")
    message(FATAL_ERROR "ShallowFetchCommit.cmake: COMMIT must be a full 40-character hash, got '${COMMIT}'")
endif()

find_package(Git REQUIRED)

function(run_git)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" ${ARGV}
        WORKING_DIRECTORY "${DEST}"
        RESULT_VARIABLE result)
    if(NOT result EQUAL 0)
        message(FATAL_ERROR "git ${ARGV} failed in ${DEST}")
    endif()
endfunction()

# Already at the right commit: nothing to do.
if(EXISTS "${DEST}/.git")
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" rev-parse HEAD
        WORKING_DIRECTORY "${DEST}"
        OUTPUT_VARIABLE head
        OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE result)
    if(result EQUAL 0 AND head STREQUAL COMMIT)
        message(STATUS "${REPO} already at ${COMMIT}")
        return()
    endif()
endif()

file(MAKE_DIRECTORY "${DEST}")

if(NOT EXISTS "${DEST}/.git")
    run_git(init --quiet)
    run_git(remote add origin "${REPO}")
endif()

message(STATUS "Fetching ${REPO} at ${COMMIT}")
run_git(-c advice.detachedHead=false fetch --depth 1 --no-tags origin "${COMMIT}")
run_git(-c advice.detachedHead=false checkout --force --detach FETCH_HEAD)
