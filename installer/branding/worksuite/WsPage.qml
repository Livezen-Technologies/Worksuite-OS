/* Page frame shared by the WorkSuite installer pages: the design's gradient, the "STEP n · SUB-STEP" eyebrow, title
   and subtitle, with content in the default slot below. Also implements:
   - Express install: steps that Express fills with defaults pass themselves over in the direction the user moves;
   - sub-steps inside one Calamares page (subCount > 1): the footer's Back and Continue move between them. */
import io.calamares.ui 1.0
import io.calamares.core 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

Item {
    id: page
    property int step: 1
    property string eyebrow
    property string title
    property string subtitle
    property color eyebrowColor: "#18D4F0"
    property bool skipInExpress: false
    property int subCount: 1
    property int subStep: 0
    property bool subNextOk: true
    property bool active: false
    property url background: "page-bg.svg"
    default property alias content: body.data
    property WsState state: WsState {}

    // This page's position in settings.conf's sequence (as in calamares-sidebar.qml). Calamares' keyboardq and
    // summaryq never pass onActivate to their QML, and usersq, keyboardq and localeq never pass onLeave, so pages
    // follow the current step themselves.
    property int stepIndex: -1
    signal activated()
    Connections {
        target: ViewManager
        function onCurrentStepChanged() { page.follow() }
    }
    Component.onCompleted: { lastRequest = state.get("subRequest", ""); follow() }
    function follow() {
        if (ViewManager.currentStepIndex === stepIndex) arrive()
        else if (active) leave()
    }

    function arrive() {
        if (active) return
        active = true
        // A request made on an earlier page (the Disk page's sub-steps too) is not one for this page.
        lastRequest = state.get("subRequest", "")
        var i = ViewManager.currentStepIndex
        var last = state.get("lastStep", -1)
        // Coming back from a later step lands on the last sub-step.
        if (i < last) subStep = subCount - 1
        state.set("lastStep", i)
        report()
        activated()
        if (skipInExpress && state.get("express", false)) {
            skipTimer.forward = i > last
            skipTimer.start()
        }
    }
    function leave() {
        active = false
        state.set("subCount", 0)
        state.set("subStep", 0)
    }
    function report() {
        if (!active) return
        state.set("subCount", subCount)
        state.set("subStep", subStep)
        state.set("subNextOk", subNextOk)
    }
    onSubStepChanged: report()
    onSubNextOkChanged: report()

    // Leave just after activation rather than from inside Calamares' own step change.
    Timer {
        id: skipTimer
        property bool forward: true
        interval: 50
        onTriggered: forward ? ViewManager.next() : ViewManager.back()
    }

    // The footer asks for the next or previous sub-step.
    property string lastRequest: ""
    Timer {
        interval: 100; repeat: true; running: page.active && page.subCount > 1
        onTriggered: {
            var r = page.state.get("subRequest", "")
            if (r === "" || r === page.lastRequest) return
            page.lastRequest = r
            if (r.indexOf("next:") === 0 && page.subStep < page.subCount - 1) page.subStep++
            else if (r.indexOf("back:") === 0 && page.subStep > 0) page.subStep--
            page.report()
        }
    }

    // Rendered at its on-screen size, so the background is never scaled. Off the UI thread and cached: every page
    // shares the same SVG at the same size, so it is rasterised once instead of on each page change.
    Image { anchors.fill: parent; source: page.background; sourceSize: Qt.size(Math.max(1, width), Math.max(1, height)); smooth: false; asynchronous: true; cache: true }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 56; anchors.rightMargin: 56; anchors.topMargin: 40; anchors.bottomMargin: 24
        spacing: 24
        ColumnLayout {
            spacing: 6
            visible: page.title !== ""
            Text { text: page.eyebrow.toUpperCase(); color: page.eyebrowColor; font.family: "IBM Plex Mono"; font.pixelSize: 12; font.letterSpacing: 1 }
            Text { Layout.fillWidth: true; text: page.title; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 30; font.weight: Font.Bold; font.letterSpacing: -0.6; wrapMode: Text.WordWrap }
            Text { Layout.fillWidth: true; Layout.maximumWidth: 640; text: page.subtitle; color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 15; wrapMode: Text.WordWrap; visible: text !== "" }
        }
        Item { id: body; Layout.fillWidth: true; Layout.fillHeight: true }
    }
}
