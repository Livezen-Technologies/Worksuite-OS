# WorkSuite installer steps that stock Calamares lacks (WSOS-INS-003, WSOS-INS-004).
# Built against the target's Calamares (Debian trixie) by packaging/debian/rules; standalone:
#   cmake -S installer/modules/worksuiteconfirm -B build && cmake --build build
cmake_minimum_required(VERSION 3.16)
project(worksuiteconfirm LANGUAGES CXX)
# Calamares 3.3 exports KF5/KF6::CoreAddons in its link interface without finding it.
find_package(KF6CoreAddons QUIET)
if(NOT KF6CoreAddons_FOUND)
    find_package(KF5CoreAddons QUIET)
endif()
find_package(Calamares REQUIRED)
calamares_add_plugin(worksuiteconfirm
    TYPE viewmodule
    EXPORT_MACRO PLUGINDLLEXPORT_PRO
    SOURCES
        WorksuiteConfirmViewStep.cpp
    SHARED_LIB
)
# The QML focus fix (WorksuiteConfirmViewStep.cpp, QmlFocus) moves Qt's focus window into the embedded QML page
# through the QPA interface, which is in Qt's private headers (Debian: qt6-base-private-dev).
if(TARGET Qt6::Core)
    find_package(Qt6 REQUIRED COMPONENTS Gui)
    target_link_libraries(calamares_viewmodule_worksuiteconfirm PRIVATE Qt6::GuiPrivate)
    target_compile_definitions(calamares_viewmodule_worksuiteconfirm PRIVATE WORKSUITE_QPA_FOCUS)
endif()

option(WORKSUITE_TESTS "Build unit tests" OFF)
if(WORKSUITE_TESTS)
    # Same Qt major as the Calamares we build against (Qt5 on 3.3.5, Qt6 on newer builds).
    if(TARGET Qt6::Core)
        set(_qt 6)
    else()
        set(_qt 5)
    endif()
    find_package(Qt${_qt} REQUIRED COMPONENTS Test)
    enable_testing()
    add_executable(worksuiteconfirm-tests Tests.cpp)
    set_target_properties(worksuiteconfirm-tests PROPERTIES AUTOMOC ON)
    target_link_libraries(worksuiteconfirm-tests calamares_viewmodule_worksuiteconfirm Qt${_qt}::Test)
    add_test(NAME worksuiteconfirm COMMAND worksuiteconfirm-tests)
endif()
