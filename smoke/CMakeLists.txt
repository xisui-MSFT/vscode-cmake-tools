find_program(CODE_EXECUTABLE code)

function(add_smoke_test name)
    get_filename_component(smoke_dir "${CMAKE_CURRENT_SOURCE_DIR}/${name}" ABSOLUTE)
    get_filename_component(smoke_tmp_dir "${CMAKE_CURRENT_BINARY_DIR}/smoke-roots/${name}" ABSOLUTE)
    set(test_name cmt.smoke.${name})
    set(setup ${test_name}.setup)
    add_test(
        NAME "${setup}.preclean"
        COMMAND "${CMAKE_COMMAND}" -E remove_directory "${smoke_tmp_dir}"
    )
    add_test(
        NAME "${setup}.mkdir"
        COMMAND "${CMAKE_COMMAND}" -E copy_directory "${smoke_dir}" "${smoke_tmp_dir}"
    )
    set_property(TEST "${setup}.preclean" PROPERTY FIXTURES_SETUP ${name}.preclean)
    set_tests_properties("${setup}.mkdir" PROPERTIES
        FIXTURES_REQUIRED ${name}.preclean
        FIXTURES_SETUP ${name}.mkdir
        )
    add_test(
        NAME "${test_name}"
        COMMAND
            "${CODE_EXECUTABLE}"
            "${smoke_tmp_dir}"
            "--extensionDevelopmentPath=${PROJECT_SOURCE_DIR}"
            "--extensionTestsPath=${PROJECT_SOURCE_DIR}/out/smoke/smoke"
            "--verbose"
        )
    set(environ
        # Tell the test runner where the project root is:
        "CMT_SMOKE_DIR=${smoke_tmp_dir}"
        # Tell the StateManager to clear all data before initializing, to
        # prevent tests from leaving around stale data.
        "CMT_RESET_STATE=1"
        # Disable user-interaction checks
        "CMT_SILENT=1"
        "CMT_TESTING=1"
        )
    set_tests_properties("${test_name}" PROPERTIES
        FIXTURES_REQUIRED ${name}.mkdir
        ENVIRONMENT "${environ}"
        PASS_REGULAR_EXPRESSION "<<CTEST-PASS-COOKIE d0a0da84-3463-4a9a-9d06-185043365aaa>>"
        FAIL_REGULAR_EXPRESSION "<<CTEST-FAIL-COOKIE c2ec4143-1c63-43ea-80e8-29c1abb2956b>>"
        # Only one VSCode instance can execute at a time for running tests
        RESOURCE_LOCK code-mutex
        # You have one minute. May be extended in the future
        TIMEOUT 60
        )
endfunction()

add_smoke_test(no-project)
add_smoke_test(bad-project)
add_smoke_test(configure)
add_smoke_test(build)
add_smoke_test(bad-build)

