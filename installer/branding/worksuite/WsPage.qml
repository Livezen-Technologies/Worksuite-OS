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

    // Called from each page's onActivate() / onLeave().
    function arrive() {
        active = true
        var i = ViewManager.currentStepIndex
        var last = state.get("lastStep", -1)
        // Coming back from a later step lands on the last sub-step.
        if (i < last) subStep = subCount - 1
        state.set("lastStep", i)
        report()
        if (skipInExpress && state.get("express", false))
            Qt.callLater(i > last ? ViewManager.next : ViewManager.back)
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
    Component.onCompleted: lastRequest = state.get("subRequest", "")

    Image { anchors.fill: parent; source: page.background; sourceSize.width: 1020; sourceSize.height: 720 }

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
