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
        EnrollLink.cpp
        WsStyle.cpp
        WsIntro.cpp
    SHARED_LIB
)
# The QML focus fix (WorksuiteConfirmViewStep.cpp, QmlFocus) moves Qt's focus window into the embedded QML page
# through the QPA interface, which is in Qt's private headers (Debian: qt6-base-private-dev).
if(TARGET Qt6::Core)
    find_package(Qt6 REQUIRED COMPONENTS Gui QuickWidgets)
    target_link_libraries(calamares_viewmodule_worksuiteconfirm PRIVATE Qt6::GuiPrivate Qt6::QuickWidgets)
    target_compile_definitions(calamares_viewmodule_worksuiteconfirm PRIVATE WORKSUITE_QPA_FOCUS)
else()
    # The loading curtain (WsIntro.cpp) renders the QML pages for its cross-fade.
    find_package(Qt5 REQUIRED COMPONENTS QuickWidgets)
    target_link_libraries(calamares_viewmodule_worksuiteconfirm PRIVATE Qt5::QuickWidgets)
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
    # Enrollment link parsing and the private pending file (WSOS-INS-006): QtCore only.
    add_executable(worksuiteenroll-tests EnrollTests.cpp EnrollLink.cpp)
    set_target_properties(worksuiteenroll-tests PROPERTIES AUTOMOC ON)
    target_link_libraries(worksuiteenroll-tests Qt${_qt}::Core Qt${_qt}::Test)
    add_test(NAME worksuiteenroll COMMAND worksuiteenroll-tests)
endif()
