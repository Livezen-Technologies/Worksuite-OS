/* WorkSuite installer sidebar (design: "WorkSuite OS Boot & Install" › Installer). The design's steps are fixed;
   each Calamares step (settings.conf sequence, exec counts as one) maps to one of them. */
import io.calamares.ui 1.0
import io.calamares.core 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: sideBar
    anchors.fill: parent
    implicitWidth: 288
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

    Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: "#1A2A55" }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 28; anchors.rightMargin: 28; anchors.topMargin: 40; anchors.bottomMargin: 40
        spacing: 36

        RowLayout {
            spacing: 12
            Image { source: "file:/" + Branding.imagePath(Branding.ProductLogo); sourceSize.width: 24; sourceSize.height: 30; fillMode: Image.PreserveAspectFit }
            Text { text: qsTr("WorkSuite OS Setup"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 17; font.weight: Font.DemiBold }
        }

        ColumnLayout {
            spacing: 4
            Repeater {
                model: sideBar.labels
                Rectangle {
                    readonly property bool done: index < sideBar.current || sideBar.finished
                    readonly property bool active: index === sideBar.current && !sideBar.finished
                    Layout.fillWidth: true
                    implicitHeight: 44
                    radius: 8
                    color: active ? "#2E1F6BFF" : "transparent"   // rgba(31,107,255,0.18)
                    RowLayout {
                        anchors.fill: parent; anchors.leftMargin: 12; anchors.rightMargin: 12
                        spacing: 12
                        Rectangle {
                            width: 24; height: 24; radius: 12
                            color: done ? "#5FD39A" : active ? "#1F6BFF" : "#1A2A55"
                            Text {
                                anchors.centerIn: parent
                                text: done ? "✓" : String(index + 1)
                                color: done || active ? "#FFFFFF" : "#8FA3C8"
                                font.family: "IBM Plex Mono"; font.pixelSize: 12; font.weight: Font.DemiBold
                            }
                        }
                        Text {
                            Layout.fillWidth: true
                            text: modelData
                            color: done || active ? "#E8EEFA" : "#8FA3C8"
                            font.family: "IBM Plex Sans"; font.pixelSize: 14
                            font.weight: active ? Font.DemiBold : Font.Normal
                        }
                    }
                }
            }
        }

        Item { Layout.fillHeight: true }

        Text { text: Branding.string(Branding.Version) + " · amd64"; color: "#5E739C"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
    }
}
