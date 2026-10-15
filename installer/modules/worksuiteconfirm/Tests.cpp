#include "WorksuiteConfirmViewStep.h"

#include <QtTest/QtTest>

class WorksuiteConfirmTests : public QObject
{
    Q_OBJECT
private slots:
    void diskFromJobs()
    {
        using S = WorksuiteConfirmViewStep;
        QCOMPARE( S::diskFromDescriptions( { "Create new GPT partition table on /dev/nvme0n1 (Samsung SSD 980).",
                                             "Create new 512MiB partition on /dev/nvme0n1 with file system fat32.",
                                             "Format partition /dev/nvme0n1p2 with luks2" } ),
                  QStringLiteral( "nvme0n1" ) );
        QCOMPARE( S::diskFromDescriptions( { "Create new MSDOS partition table on /dev/sda.", "Set flags on /dev/sda1" } ),
                  QStringLiteral( "sda" ) );
        // Two disks or none: refuse to guess.
        QCOMPARE( S::diskFromDescriptions( { "Erase /dev/sda", "Erase /dev/sdb" } ), QString() );
        QCOMPARE( S::diskFromDescriptions( { "Set hostname" } ), QString() );
    }
    void typedConfirmation()
    {
        using S = WorksuiteConfirmViewStep;
        QVERIFY( S::confirmationMatches( "nvme0n1", "nvme0n1" ) );
        QVERIFY( S::confirmationMatches( " /dev/nvme0n1 ", "nvme0n1" ) );
        QVERIFY( !S::confirmationMatches( "nvme0n", "nvme0n1" ) );
        QVERIFY( !S::confirmationMatches( "NVME0N1", "nvme0n1" ) );
        QVERIFY( !S::confirmationMatches( "", "" ) );
    }
    void diskHeader()
    {
        using S = WorksuiteConfirmViewStep;
        QString model, size;
        S::parseLsblk( "MODEL=\"\" SIZE=\"40G\"\n", model, size );
        QCOMPARE( model, QString() );
        QCOMPARE( size, QStringLiteral( "40G" ) );
        QCOMPARE( S::diskTitle( "vda", model, size ), QStringLiteral( "vda · 40G" ) );
        S::parseLsblk( "MODEL=\"Samsung SSD 980 \" SIZE=\"931.5G\"", model, size );
        QCOMPARE( S::diskTitle( "nvme0n1", model, size ), QStringLiteral( "Samsung SSD 980 · 931.5G (nvme0n1)" ) );
        QCOMPARE( S::diskTitle( "sda", "", "" ), QStringLiteral( "sda" ) );
    }
    void opTags()
    {
        using S = WorksuiteConfirmViewStep;
        QCOMPARE( S::opKind( "Clear mounts for partitioning operations on /dev/vda" ), QString() );
        QCOMPARE( S::opKind( "Create new GPT partition table on /dev/vda" ), QStringLiteral( "CREATE" ) );
        QCOMPARE( S::opKind( "Format partition /dev/vda2 with luks2" ), QStringLiteral( "FORMAT" ) );
        QCOMPARE( S::opKind( "Delete partition /dev/vda1" ), QStringLiteral( "DELETE" ) );
        QCOMPARE( S::opKind( "Set flags on /dev/vda1 to boot" ), QStringLiteral( "OTHER" ) );
        QVERIFY( S::encryptedFromDescriptions( { "Create new 40G partition on /dev/vda with file system luks2" } ) );
        QVERIFY( !S::encryptedFromDescriptions( { "Create new 40G partition on /dev/vda with file system ext4" } ) );
    }
    void dialogStyle()
    {
        const QString sheet = "/* c { } */ #mainApp { color: red; }\nQPushButton, QToolButton { padding: 8px; }\n"
                              "QMessageBox QLabel { color: #fff; }\nQDialog { background: #000; }";
        QCOMPARE( WorksuiteConfirmViewStep::dialogStyleSheet( sheet ),
                  QString( "QDialog QPushButton, QDialog QToolButton { padding: 8px; }\n"
                           "QMessageBox QLabel { color: #fff; }\nQDialog { background: #000; }\n" ) );
    }
};

QTEST_GUILESS_MAIN( WorksuiteConfirmTests )
#include "Tests.moc"
