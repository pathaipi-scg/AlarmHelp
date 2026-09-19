"""SELECT-only, bounded access to the existing SQL Server alarm history."""
import os
import re
from dotenv import dotenv_values
from contextlib import contextmanager

def connection_string():
    explicit = os.getenv('ALARM_HELP_SQL_CONNECTION_STRING')
    if explicit:
        return explicit
    filename = os.getenv('ALARM_HELP_SQL_ENV_FILE')
    if not filename:
        raise RuntimeError('AlarmHelp SQL configuration is missing')
    values = dotenv_values(filename)
    import pyodbc
    driver = values.get('SQL_DRIVER') or 'AUTO'
    installed = pyodbc.drivers()
    if driver.upper() == 'AUTO':
        supported = [(int(m[1]), name) for name in installed
                     if (m := re.fullmatch(r'ODBC Driver (\d+) for SQL Server', name)) and int(m[1]) >= 17]
        if not supported:
            raise RuntimeError('Microsoft SQL Server ODBC Driver 17+ is required')
        driver = max(supported)[1]
    elif driver not in installed:
        raise RuntimeError('Configured SQL driver is not installed')
    def quote(value):
        return '{' + value.replace('}', '}}') + '}'
    fields = {'DRIVER': driver}
    for field, key in [('SERVER','SQL_SERVER'), ('DATABASE','SQL_DB'), ('UID','SQL_USER'), ('PWD','SQL_PASS')]:
        if not values.get(key):
            raise RuntimeError('Required SQL setting is missing')
        fields[field] = values[key]
    encrypt = (values.get('SQL_ENCRYPT') or '').lower()
    if encrypt not in {'', 'yes', 'no'}:
        raise RuntimeError('Invalid SQL encryption setting')
    if encrypt:
        fields['Encrypt'] = encrypt
    trust = (values.get('SQL_TRUST_SERVER_CERTIFICATE') or '').lower()
    if trust not in {'1','true','yes','on','0','false','no','off'}:
        raise RuntimeError('Invalid SQL certificate setting')
    fields['TrustServerCertificate'] = 'yes' if trust in {'1','true','yes','on'} else 'no'
    return ''.join(f'{key}={quote(value)};' for key, value in fields.items())

@contextmanager
def connection():
    import pyodbc
    setting = connection_string()
    if not setting:
        raise RuntimeError('AlarmHelp SQL connection is not configured')
    conn = pyodbc.connect(setting, timeout=5, autocommit=True)
    conn.timeout = 8
    try:
        yield conn
    finally:
        conn.close()

def configured():
    return bool(os.getenv('ALARM_HELP_SQL_CONNECTION_STRING') or os.getenv('ALARM_HELP_SQL_ENV_FILE'))

def history_page(limit=50, before=None, history_id=None):
    clauses, params = [], [limit + 1]
    if before is not None:
        clauses.append('h.HistoryId < ?')
        params.append(before)
    if history_id is not None:
        clauses.append('h.HistoryId = ?')
        params.append(history_id)
    where = 'WHERE ' + ' AND '.join(clauses) if clauses else ''
    with connection() as conn:
        rows = conn.cursor().execute(f'''
            SELECT TOP (?) h.HistoryId, h.AlarmId, h.TagPath,
                   h.CurrentValue, h.CreatedTime, a.Priority
            FROM dbo.Alarm_History h
            LEFT JOIN dbo.Alarm_Lists a ON a.AlarmId = h.AlarmId
            {where} ORDER BY h.HistoryId DESC
        ''', *params).fetchall()
    alarms = []
    for row in rows[:limit]:
        path = row[2].replace('/', '.')
        alarms.append(dict(history_id=str(row[0]), alarm_id=row[1], kepware_path=path,
                           tag_name=path.split('.')[-1], value=row[3],
                           activated_at=row[4].isoformat(), priority=row[5] or 0,
                           state='UNKNOWN'))
    return {'alarms': alarms, 'next_cursor': alarms[-1]['history_id'] if len(rows) > limit else None}

WINDOW_HOURS = {'24h': 24, '48h': 48, '1w': 168, '1m': 720}

def pareto(window):
    # SQL local time matches the history writer's GETDATE()/datetime timestamps.
    with connection() as conn:
        rows = conn.cursor().execute('''
            DECLARE @end datetime = GETDATE();
            SELECT AlarmId, MAX(TagPath) AS TagPath, COUNT_BIG(*) AS Occurrences
            FROM dbo.Alarm_History
            WHERE CreatedTime >= DATEADD(hour, ?, @end) AND CreatedTime <= @end
            GROUP BY AlarmId
            ORDER BY Occurrences DESC, AlarmId ASC
        ''', -WINDOW_HOURS[window]).fetchall()
    total = sum(int(row[2]) for row in rows)
    cumulative, alarms = 0, []
    for alarm_id, path, count in rows:
        count = int(count)
        cumulative += count
        alarms.append(dict(alarm_id=alarm_id, kepware_path=path.replace('/', '.'),
                           tag_name=path.replace('/', '.').split('.')[-1], count=count,
                           percentage=100 * count / total,
                           cumulative_percentage=100 * cumulative / total))
    return {'window': window, 'total': total, 'alarms': alarms}
