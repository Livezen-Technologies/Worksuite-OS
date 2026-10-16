#include "EnrollLink.h"

#include <QFile>
#include <QTemporaryDir>
#include <QtTest/QtTest>
#include <sys/stat.h>

class EnrollTests : public QObject
{
    Q_OBJECT
private slots:
    void server()
    {
        using namespace WsEnroll;
        QCOMPARE( normalizeServer( "work.example.com" ), QStringLiteral( "https://work.example.com/" ) );
        QCOMPARE( normalizeServer( " https://Work.Example.com:8443/ws " ), QStringLiteral( "https://work.example.com:8443/ws/" ) );
        QCOMPARE( normalizeServer( "http://work.example.com" ), QString() );
        QCOMPARE( normalizeServer( "https://user:pw@work.example.com" ), QString() );
        QCOMPARE( normalizeServer( "https://work.example.com/?x=1" ), QString() );
        QCOMPARE( normalizeServer( "work example" ), QString() );
        QCOMPARE( normalizeServer( "" ), QString() );
    }
    void link()
    {
        using namespace WsEnroll;
        Target t;
        QVERIFY( parseLink( "https://ws.example.com/enroll#token=wse_AbC-123_xyz", t ) );
        QCOMPARE( t.server, QStringLiteral( "https://ws.example.com/" ) );
        QCOMPARE( t.token, QStringLiteral( "wse_AbC-123_xyz" ) );
        QVERIFY( parseLink( "https://ws.example.com/base/enroll?token=wse_AbC-123_xyz", t ) );
        QCOMPARE( t.server, QStringLiteral( "https://ws.example.com/base/" ) );
        QVERIFY( !parseLink( "http://ws.example.com/enroll#token=wse_AbC-123_xyz", t ) );
        QVERIFY( !parseLink( "https://ws.example.com/enroll#token=a b", t ) );
        QVERIFY( !parseLink( "https://ws.example.com/other#token=wse_AbC-123_xyz", t ) );
        QVERIFY( !parseLink( "wse_AbC-123_xyz", t ) );
    }
    void fields()
    {
        using namespace WsEnroll;
        Target t;
        QVERIFY( fromFields( "ws.example.com", " wse_AbC-123_xyz ", t ) );
        QCOMPARE( t.token, QStringLiteral( "wse_AbC-123_xyz" ) );
        QVERIFY( fromFields( "", "https://ws.example.com/enroll#token=wse_AbC-123_xyz", t ) );
        QVERIFY( fromFields( "https://ws.example.com/enroll#token=wse_AbC-123_xyz", "", t ) );
        QVERIFY( !fromFields( "ws.example.com", "short", t ) );
        QVERIFY( !fromFields( "", "wse_AbC-123_xyz", t ) );
        QCOMPARE( toJson( { "https://a.example/", "wse_12345678" } ), QByteArray( "{\"enrollment_token\":\"wse_12345678\",\"server\":\"https://a.example/\"}" ) );
    }
    void pendingFileIsPrivate()
    {
        QTemporaryDir d;
        const QString p = d.filePath( "enroll.json" );
        QFile pre( p );
        QVERIFY( pre.open( QIODevice::WriteOnly ) );  // a stale, wider file is replaced, not reused
        pre.setPermissions( QFileDevice::Permissions( 0x6666 ) );
        pre.close();
        QVERIFY( WsEnroll::writePending( p, { "https://a.example/", "wse_12345678" } ) );
        struct stat st;
        QCOMPARE( ::stat( QFile::encodeName( p ).constData(), &st ), 0 );
        QCOMPARE( int( st.st_mode & 0777 ), 0600 );
        QFile f( p );
        QVERIFY( f.open( QIODevice::ReadOnly ) );
        QVERIFY( f.readAll().contains( "wse_12345678" ) );
    }
};

QTEST_GUILESS_MAIN( EnrollTests )
#include "EnrollTests.moc"
