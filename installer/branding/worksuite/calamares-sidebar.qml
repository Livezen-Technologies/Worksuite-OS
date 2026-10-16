/* WorkSuite installer sidebar (design: "WorkSuite OS Boot & Install" › Sidebar component). Six steps; the current
   one opens to list its sub-steps. Each Calamares step (settings.conf sequence, exec counts as one) maps to a step
   and a sub-step; pages with several sub-steps of their own (Your account) report which one is showing through
   WsState. Calamares fixes the sidebar's width; stylesheet.qss widens it to the design's 260 px. */
import io.calamares.ui 1.0
import io.calamares.core 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: sideBar
    anchors.fill: parent
    color: "#071330"

    property WsState state: WsState {}
    // Calamares step index → [design step, first sub-step]: welcome, keyboard | partition | users | locale |
    // summary, confirm-erase | install, recovery key, finished.
    readonly property var stepOf: [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [5, 0], [5, 2], [5, 3]]
    readonly property var steps: [
        [qsTr("Language"), [qsTr("Language"), qsTr("Keyboard")]],
        [qsTr("Installation type"), [qsTr("Disk"), qsTr("Encryption")]],
        [qsTr("Your account"), [qsTr("Name and password"), qsTr("Computer name")]],
        [qsTr("Time zone"), [qsTr("Region and city")]],
        [qsTr("Review"), [qsTr("Summary"), qsTr("Confirm disk")]],
        [qsTr("Install"), [qsTr("Copy files"), qsTr("Configure system"), qsTr("Recovery key"), qsTr("Complete")]]
    ]

    // Global storage has no change signal for QML and pages live in other engines, so re-read the shared state.
    property bool express: false
    property int pageSub: 0
    property bool encrypt: false
    property string phase: ""
    Timer {
        interval: 200; running: true; repeat: true; triggeredOnStart: true
        onTriggered: {
            sideBar.express = sideBar.state.get("express", false)
            sideBar.pageSub = sideBar.state.get("subStep", 0)
            sideBar.encrypt = sideBar.state.get("encrypt", false)   // the partition page's Encrypt box (worksuiteconfirm)
            sideBar.phase = Global.value("worksuitePhase") || ""   // the install stage (worksuitephase markers)
        }
    }
    readonly property int stepIndex: ViewManager.currentStepIndex
    readonly property var position: stepIndex >= 0 && stepIndex < stepOf.length ? stepOf[stepIndex] : [0, 0]
    readonly property int current: position[0]
    // The account page reports its own sub-step; the partition page is one page for Disk and Encryption: once its
    // Encrypt box is ticked, Disk is done and Encryption is the current sub-step.
    // The install is one Calamares step for Copy files and Configure system: past unpacking, Configure is current.
    readonly property bool configuring: phase !== "" && phase !== "prepare" && phase !== "copy"
    readonly property int currentSub: current === 2 ? pageSub : current === 1 && encrypt ? 1
                                      : current === 5 && position[1] === 0 && configuring ? 1 : position[1]

    Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: "#1F7FB2FF" }   // rgba(127,178,255,0.12)

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 20; anchors.rightMargin: 20; anchors.topMargin: 32; anchors.bottomMargin: 32
        spacing: 28

        RowLayout {
            spacing: 12
            Image { source: "mark.svg"; sourceSize.width: 28; sourceSize.height: 28; Layout.preferredWidth: 28; Layout.preferredHeight: 28 }
            Text { text: qsTr("WorkSuite OS Setup"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 16; font.weight: Font.DemiBold }
        }

        ColumnLayout {
            spacing: 2
            Repeater {
                model: sideBar.steps
                ColumnLayout {
                    id: step
                    readonly property int stepNo: index
                    readonly property bool done: index < sideBar.current
                    readonly property bool active: index === sideBar.current
                    readonly property var subs: modelData[1]
                    Layout.fillWidth: true
                    spacing: 0

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: 42
                        radius: 8
                        color: step.active ? "#2E1F6BFF" : "transparent"   // rgba(31,107,255,0.18)
                        RowLayout {
                            anchors.fill: parent; anchors.leftMargin: 10; anchors.rightMargin: 10
                            spacing: 12
                            Rectangle {
                                width: 24; height: 24; radius: 12
                                color: step.done ? "#5FD39A" : step.active ? "#1F6BFF" : "#1F7FB2FF"
                                Text {
                                    anchors.centerIn: parent
                                    text: step.done ? "✓" : String(step.stepNo + 1)
                                    color: step.done || step.active ? "#FFFFFF" : "#8FA3C8"
                                    font.family: "IBM Plex Mono"; font.pixelSize: 12; font.weight: Font.DemiBold
                                }
                            }
                            Text {
                                Layout.fillWidth: true
                                text: modelData[0]
                                color: step.done || step.active ? "#E8EEFA" : "#8FA3C8"
                                font.family: "IBM Plex Sans"; font.pixelSize: 14
                                font.weight: step.active ? Font.DemiBold : Font.Normal
                                elide: Text.ElideRight
                            }
                        }
                    }

                    // Sub-steps of the open step, on a rail.
                    Item {
                        visible: step.active
                        Layout.fillWidth: true
                        Layout.topMargin: 4; Layout.bottomMargin: 6
                        implicitHeight: subList.implicitHeight
                        Rectangle { x: 21; width: 2; height: parent.height; color: "#2E7FB2FF" }   // rgba(127,178,255,0.18)
                        ColumnLayout {
                            id: subList
                            x: 41; width: parent.width - 41
                            spacing: 2
                            Repeater {
                                model: step.subs
                                Rectangle {
                                    id: sub
                                    // Express skips the keyboard page; the time zone keeps its default.
                                    readonly property bool skipped: sideBar.express && step.stepNo === 0 && index === 1
                                    readonly property bool auto: sideBar.express && step.stepNo === 3
                                    readonly property bool subDone: index < sideBar.currentSub
                                    readonly property bool subActive: index === sideBar.currentSub
                                    visible: !skipped
                                    Layout.fillWidth: true
                                    implicitHeight: 30
                                    radius: 6
                                    color: subActive ? "#1418D4F0" : "transparent"   // rgba(24,212,240,0.08)
                                    RowLayout {
                                        anchors.fill: parent; anchors.leftMargin: 8; anchors.rightMargin: 8
                                        spacing: 10
                                        Rectangle {
                                            width: 7; height: 7; radius: 3.5
                                            color: sub.subDone ? "#5FD39A" : sub.subActive ? "#18D4F0" : "#407FB2FF"
                                        }
                                        Text {
                                            Layout.fillWidth: true
                                            text: modelData
                                            color: sub.subDone || sub.subActive ? "#E8EEFA" : "#8FA3C8"
                                            font.family: "IBM Plex Sans"; font.pixelSize: 13
                                            font.weight: sub.subActive ? Font.DemiBold : Font.Normal
                                            elide: Text.ElideRight
                                        }
                                        Text { visible: sub.auto; text: "AUTO"; color: "#5E739C"; font.family: "IBM Plex Mono"; font.pixelSize: 10 }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Item { Layout.fillHeight: true }

        ColumnLayout {
            spacing: 6
            Text { text: sideBar.express ? qsTr("Express install") : qsTr("Custom install"); color: "#5E739C"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
            Text { text: Branding.string(Branding.VersionedName).split(" ").pop() + " · amd64 · EFI"; color: "#5E739C"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
        }
    }
}
