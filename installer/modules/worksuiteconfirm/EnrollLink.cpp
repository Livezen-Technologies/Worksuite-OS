#include "EnrollLink.h"

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QUrl>
#include <QUrlQuery>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace WsEnroll
{

QString
normalizeServer( const QString& typed )
{
    QString s = typed.trimmed();
    if ( s.isEmpty() || s.contains( QRegularExpression( QStringLiteral( "\\s" ) ) ) )
    {
        return QString();
    }
    if ( !s.contains( QStringLiteral( "://" ) ) )
    {
        s = QStringLiteral( "https://" ) + s;
    }
    const QUrl u( s, QUrl::StrictMode );
    if ( !u.isValid() || u.scheme() != QLatin1String( "https" ) || u.host().isEmpty() || !u.userInfo().isEmpty()
         || u.hasQuery() || u.hasFragment() )
    {
        return QString();
    }
    static const QRegularExpression host( QStringLiteral( "^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$" ) );
    if ( !host.match( u.host() ).hasMatch() )
    {
        return QString();
    }
    QString path = u.path();
    if ( !path.endsWith( QLatin1Char( '/' ) ) )
    {
        path += QLatin1Char( '/' );
    }
    QString out = QStringLiteral( "https://" ) + u.host().toLower();
    if ( u.port() > 0 )
    {
        out += QLatin1Char( ':' ) + QString::number( u.port() );
    }
    return out + path;
}

bool
validToken( const QString& token )
{
    static const QRegularExpression re( QStringLiteral( "^[A-Za-z0-9_.~-]{8,512}$" ) );
    return re.match( token ).hasMatch();
}

bool
parseLink( const QString& link, Target& out )
{
    const QUrl u( link.trimmed(), QUrl::StrictMode );
    if ( !u.isValid() || u.scheme() != QLatin1String( "https" ) || !u.path().endsWith( QLatin1String( "/enroll" ) ) )
    {
        return false;
    }
    QString token = QUrlQuery( u.fragment( QUrl::FullyEncoded ) ).queryItemValue( QStringLiteral( "token" ), QUrl::FullyDecoded );
    if ( token.isEmpty() )
    {
        token = QUrlQuery( u ).queryItemValue( QStringLiteral( "token" ), QUrl::FullyDecoded );
    }
    QUrl base( u );
    base.setFragment( QString() );
    base.setQuery( QString() );
    base.setPath( u.path().left( u.path().size() - int( qstrlen( "enroll" ) ) ) );
    const QString server = normalizeServer( base.toString() );
    if ( server.isEmpty() || !validToken( token ) )
    {
        return false;
    }
    out = { server, token };
    return true;
}

bool
fromFields( const QString& server, const QString& code, Target& out )
{
    if ( parseLink( code, out ) || parseLink( server, out ) )
    {
        return true;
    }
    const QString s = normalizeServer( server );
    const QString c = code.trimmed();
    if ( s.isEmpty() || !validToken( c ) )
    {
        return false;
    }
    out = { s, c };
    return true;
}

QByteArray
toJson( const Target& t )
{
    QJsonObject o;
    o.insert( QStringLiteral( "server" ), t.server );
    o.insert( QStringLiteral( "enrollment_token" ), t.token );
    return QJsonDocument( o ).toJson( QJsonDocument::Compact );
}

QString
pendingPath()
{
    return QStringLiteral( "/run/worksuite-installer-enroll.json" );
}

bool
writePending( const QString& path, const Target& t )
{
    const QByteArray p = QFile::encodeName( path );
    ::unlink( p.constData() );  // never reuse a file someone else created
    const int fd = ::open( p.constData(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600 );
    if ( fd < 0 )
    {
        return false;
    }
    const QByteArray data = toJson( t );
    const bool ok = ::fchmod( fd, 0600 ) == 0 && ::write( fd, data.constData(), size_t( data.size() ) ) == data.size();
    ::close( fd );
    if ( !ok )
    {
        ::unlink( p.constData() );
    }
    return ok;
}

}  // namespace WsEnroll
