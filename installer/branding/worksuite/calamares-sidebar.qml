/* WorkSuite installer sidebar (design: "WorkSuite OS Boot & Install" › Installer). The design's steps are fixed;
   each Calamares step (settings.conf sequence, exec counts as one) maps to one of them. Calamares 3.3 fixes a QML
   sidebar at 190 px; stylesheet.qss widens it to the design's 288 px. */
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
    // The whole process under its steps: [design step, Calamares step it belongs to, label]. The install phases
    // all run in the one exec step, so they share its state.
    readonly property var subs: [
        [0, 0, qsTr("Language")], [0, 1, qsTr("Keyboard")],
        [1, 2, qsTr("Disk")], [1, 2, qsTr("Encryption")],
        [2, 3, qsTr("Name and password")], [2, 3, qsTr("Computer name")],
        [3, 4, qsTr("Region and city")],
        [4, 5, qsTr("Summary")], [4, 6, qsTr("Confirm disk")],
        [5, 7, qsTr("Copy files")], [5, 7, qsTr("Configure system")], [5, 8, qsTr("Recovery key")], [5, 9, qsTr("Complete")]
    ]
    readonly property int current: {
        var i = ViewManager.currentStepIndex
        return i >= 0 && i < groupOf.length ? groupOf[i] : 0
    }
    readonly property bool finished: ViewManager.currentStepIndex >= lastIndex
    // Express install fills in the time zone; re-read on every step change.
    readonly property bool express: ViewManager.currentStepIndex >= 0 && State.get("express", false)

    Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: "#1F7FB2FF" }   // rgba(127,178,255,0.12)

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 28; anchors.rightMargin: 28; anchors.topMargin: 36; anchors.bottomMargin: 28
        spacing: 28

        RowLayout {
            spacing: 12
            Image { source: "mark.svg"; sourceSize.width: 30; sourceSize.height: 30; Layout.preferredWidth: 30; Layout.preferredHeight: 30 }
            Text { text: qsTr("WorkSuite OS Setup"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 17; font.weight: Font.DemiBold }
        }

        ColumnLayout {
            spacing: 4
            Repeater {
                model: sideBar.labels
                ColumnLayout {
                    id: group
                    readonly property int groupIndex: index
                    readonly property bool auto: sideBar.express && index === 3 && sideBar.current < 3
                    readonly property bool done: index < sideBar.current || sideBar.finished || auto
                    readonly property bool active: index === sideBar.current && !sideBar.finished
                    Layout.fillWidth: true
                    spacing: 2
                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 44
                    radius: 8
                    color: active ? "#2E1F6BFF" : "transparent"   // rgba(31,107,255,0.18)
                    RowLayout {
                        anchors.fill: parent; anchors.leftMargin: 12; anchors.rightMargin: 12
                        spacing: 12
                        Rectangle {
                            width: 24; height: 24; radius: 12
                            color: done ? "#5FD39A" : active ? "#1F6BFF" : "#1F7FB2FF"
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
                            elide: Text.ElideRight
                        }
                        Text {
                            visible: auto
                            text: qsTr("auto"); color: "#5E739C"; font.family: "IBM Plex Mono"; font.pixelSize: 11
                        }
                    }
                }
                // Sub-items of the active step: done ✓, current highlighted, later ones dimmed.
                Repeater {
                    model: sideBar.subs.filter(function (x) { return x[0] === group.groupIndex && !(x[1] === 1 && sideBar.express) })
                    RowLayout {
                        readonly property int stepIndex: modelData[1]
                        readonly property bool subDone: stepIndex < ViewManager.currentStepIndex || (sideBar.express && stepIndex === 4 && ViewManager.currentStepIndex < 4) || sideBar.finished
                        readonly property bool subActive: stepIndex === ViewManager.currentStepIndex && !sideBar.finished
                        Layout.fillWidth: true
                        Layout.leftMargin: 23; Layout.preferredHeight: 24
                        spacing: 22
                        Rectangle { Layout.preferredWidth: 2; Layout.fillHeight: true; color: subActive ? "#1F6BFF" : "#1F7FB2FF" }
                        Text {
                            Layout.fillWidth: true
                            text: (subDone ? "✓  " : "") + modelData[2] + (sideBar.express && stepIndex === 4 && !subActive ? qsTr(" · auto") : "")
                            color: subActive ? "#E8EEFA" : subDone ? "#5FD39A" : "#5E739C"
                            font.family: "IBM Plex Sans"; font.pixelSize: 12
                            font.weight: subActive ? Font.Medium : Font.Normal
                            elide: Text.ElideRight
                        }
                    }
                }
                }
            }
        }

        Item { Layout.fillHeight: true }

        Text { text: Branding.string(Branding.VersionedName).split(" ").pop() + " · amd64"; color: "#5E739C"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
    }
}
