/* Page frame shared by the WorkSuite installer pages: the design's gradient, the "STEP n OF 6" eyebrow, title and
   subtitle. Content goes in the default slot below the header. Also implements the Express install path: steps that
   Express fills with defaults pass themselves over in the direction the user is moving. */
import io.calamares.ui 1.0
import io.calamares.core 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15
import "WsState.js" as State

Item {
    id: page
    property int step: 1
    property string title
    property string subtitle
    property bool skipInExpress: false
    default property alias content: body.data

    // Called from each page's onActivate().
    function arrive() {
        var i = ViewManager.currentStepIndex
        var last = State.get("lastStep", -1)
        State.set("lastStep", i)
        if (skipInExpress && State.get("express", false))
            Qt.callLater(i > last ? ViewManager.next : ViewManager.back)
    }

    Image { anchors.fill: parent; source: "page-bg.svg"; sourceSize.width: 1090; sourceSize.height: 712 }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 64; anchors.rightMargin: 64; anchors.topMargin: 48; anchors.bottomMargin: 24
        spacing: 26
        ColumnLayout {
            spacing: 8
            visible: page.title !== ""
            Text { text: qsTr("STEP %1 OF 6").arg(page.step); color: "#18D4F0"; font.family: "IBM Plex Mono"; font.pixelSize: 12; font.letterSpacing: 1 }
            Text { text: page.title; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 32; font.weight: Font.Bold; font.letterSpacing: -0.6 }
            Text { Layout.fillWidth: true; text: page.subtitle; color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 15; wrapMode: Text.WordWrap; visible: text !== "" }
        }
        Item { id: body; Layout.fillWidth: true; Layout.fillHeight: true }
    }
}
