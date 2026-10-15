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
};

QTEST_GUILESS_MAIN( WorksuiteConfirmTests )
#include "Tests.moc"
