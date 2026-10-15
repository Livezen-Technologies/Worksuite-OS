/* WorkSuite installer sidebar (design: "WorkSuite OS Boot & Install" › Installer). The design's steps are fixed;
   each Calamares step (settings.conf sequence, exec counts as one) maps to one of them. Calamares 3.3 caps a QML
   sidebar at 190 px (CalamaresWindow.cpp), so this is the design's 288 px sidebar fitted to that width. */
import io.calamares.ui 1.0
import io.calamares.core 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15
import "WsState.js" as State

Rectangle {
    id: sideBar
    anchors.fill: parent
    color: "#071330"

    // Calamares step index → design step: welcome, keyboard | partition | users | locale | summary, confirm-erase | install, recovery key, finished
    readonly property var groupOf: [0, 0, 1, 2, 3, 4, 4, 5, 5, 5]
    readonly property var labels: [qsTr("Language"), qsTr("Installation type"), qsTr("Your account"), qsTr("Time zone"), qsTr("Review"), qsTr("Install")]
    readonly property int lastIndex: 9
    readonly property int current: {
        var i = ViewManager.currentStepIndex
        return i >= 0 && i < groupOf.length ? groupOf[i] : 0
    }
    readonly property bool finished: ViewManager.currentStepIndex >= lastIndex
    // Express install fills in the time zone; re-read on every step change.
    readonly property bool express: ViewManager.currentStepIndex >= 0 && State.get("express", false)

    Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: "#1A2A55" }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 14; anchors.rightMargin: 14; anchors.topMargin: 32; anchors.bottomMargin: 28
        spacing: 28

        RowLayout {
            Layout.leftMargin: 8
            spacing: 10
            Image { source: "file:/" + Branding.imagePath(Branding.ProductLogo); sourceSize.width: 24; sourceSize.height: 30; fillMode: Image.PreserveAspectFit }
            Text { text: qsTr("WorkSuite OS\nSetup"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 15; font.weight: Font.DemiBold; lineHeight: 1.1 }
        }

        ColumnLayout {
            spacing: 4
            Repeater {
                model: sideBar.labels
                Rectangle {
                    readonly property bool auto: sideBar.express && index === 3 && sideBar.current < 3
                    readonly property bool done: index < sideBar.current || sideBar.finished || auto
                    readonly property bool active: index === sideBar.current && !sideBar.finished
                    Layout.fillWidth: true
                    implicitHeight: 44
                    radius: 8
                    color: active ? "#2E1F6BFF" : "transparent"   // rgba(31,107,255,0.18)
                    RowLayout {
                        anchors.fill: parent; anchors.leftMargin: 8; anchors.rightMargin: 6
                        spacing: 10
                        Rectangle {
                            width: 24; height: 24; radius: 12
                            color: done ? "#5FD39A" : active ? "#1F6BFF" : "#1A2A55"
                            Text {
                                anchors.centerIn: parent
                                text: done ? "✓" : String(index + 1)
                            opacity: auto ? 0.7 : 1
                                color: done || active ? "#FFFFFF" : "#8FA3C8"
                                font.family: "IBM Plex Mono"; font.pixelSize: 12; font.weight: Font.DemiBold
                            }
                        }
                        Text {
                            Layout.fillWidth: true
                            text: auto ? modelData + qsTr(" · auto") : modelData
                            color: done || active ? "#E8EEFA" : "#8FA3C8"
                            font.family: "IBM Plex Sans"; font.pixelSize: 13
                            font.weight: active ? Font.DemiBold : Font.Normal
                            elide: Text.ElideRight
                        }
                    }
                }
            }
        }

        Item { Layout.fillHeight: true }

        Text { Layout.leftMargin: 8; text: Branding.string(Branding.VersionedName).split(" ").pop() + " · amd64"; color: "#5E739C"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
    }
}
