import unittest
from datetime import datetime
from unittest.mock import MagicMock, patch
import history_store as store
import app

# Exact production column names. SQLite is only a local query-execution fixture;
# tests translate TOP/DATEADD/COUNT_BIG syntax, never the column references.
PRODUCTION_SCHEMA = """
CREATE TABLE dbo.Alarm_History (
    HistoryId BIGINT PRIMARY KEY,
    AlarmId INTEGER,
    TagId BIGINT,
    TagPath NVARCHAR(1000),
    AlarmMode NVARCHAR(20),
    ThresholdHigh FLOAT,
    ThresholdLow FLOAT,
    CurrentValue FLOAT,
    Mp3File NVARCHAR(500),
    CreatedTime TIMESTAMP
)
"""

class HistoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.conn = MagicMock()
        self.cursor = self.conn.cursor.return_value
        self.query = self.cursor.execute
        self.rows = self.query.return_value.fetchall
        self.patch = patch('history_store.connection')
        self.patch.start().return_value.__enter__.return_value = self.conn
        self.addCleanup(self.patch.stop)

    def row(self, id):
        return (id, 7, 'Factory/Line/Alarm', 1, datetime(2026, 9, 19))

    def test_initial_page_and_cursor(self):
        self.rows.return_value = [self.row(i) for i in range(101, 50, -1)]
        page = store.history_page()
        self.assertEqual(len(page['alarms']), 50)
        self.assertEqual(page['alarms'][0]['history_id'], '101')
        self.assertEqual(page['next_cursor'], '52')
        self.assertIn('TOP (?)', self.query.call_args.args[0])
        self.assertIn('ORDER BY h.HistoryId DESC', self.query.call_args.args[0])
        self.assertEqual(self.query.call_args.args[1:], (51,))

    def test_older_page_is_exclusive_and_end_is_explicit(self):
        self.rows.return_value = [self.row(51), self.row(50)]
        page = store.history_page(50, 52)
        self.assertIn('h.HistoryId < ?', self.query.call_args.args[0])
        self.assertEqual(self.query.call_args.args[1:], (51, 52))
        self.assertEqual([a['history_id'] for a in page['alarms']], ['51', '50'])
        self.assertIsNone(page['next_cursor'])
        self.rows.return_value = []
        self.assertEqual(store.history_page()['alarms'], [])

    def test_detail_is_one_query_and_bigint_is_lossless(self):
        self.rows.return_value = [self.row(9007199254740993)]
        page = store.history_page(1, history_id=9007199254740993)
        self.assertEqual(page['alarms'][0]['history_id'], '9007199254740993')
        self.assertIn('h.HistoryId = ?', self.query.call_args.args[0])
        self.query.assert_called_once()

    def test_all_windows_group_count_and_percentages(self):
        for window, hours in [('24h',24), ('48h',48), ('1w',168), ('7d',168), ('1m',720), ('30d',720)]:
            with self.subTest(window=window):
                # SQL returns one group per configured AlarmId, even for identical labels.
                self.rows.return_value = [(7,'A/B/Alarm',3), (8,'A/C/Alarm',1)]
                result = store.pareto(window)
                sql, parameter = self.query.call_args.args
                self.assertEqual(parameter, -hours)
                self.assertIn('CreatedTime >= DATEADD', sql)
                self.assertIn('GROUP BY AlarmId', sql)
                self.assertIn('COUNT_BIG(*)', sql)
                self.assertIn('ORDER BY Occurrences DESC, AlarmId ASC', sql)
                self.assertEqual(result['total'], 4)
                self.assertEqual([a['percentage'] for a in result['alarms']], [75,25])
                self.assertEqual([a['cumulative_percentage'] for a in result['alarms']], [75,100])

    def test_empty_and_single_alarm(self):
        self.rows.return_value = []
        self.assertEqual(store.pareto('24h')['total'],0)
        self.rows.return_value = [(1,'A/B/Alarm',11)]
        result = store.pareto('24h')['alarms'][0]
        self.assertEqual(result['count'],11)
        self.assertEqual(result['percentage'],100)
        self.assertEqual(result['cumulative_percentage'],100)

    @patch('app.upstream_get', side_effect=AssertionError('must not access upstream'))
    def test_pareto_and_history_do_not_need_opctagmanager(self, upstream):
        self.rows.return_value = []
        self.assertEqual(app.history_list(50, None)['alarms'], [])
        self.assertEqual(app.pareto('24h')['alarms'], [])

    @patch('history_store.configured', return_value=True)
    @patch('app.upstream_get', return_value=app.JSONResponse({'error':'offline'},status_code=503))
    def test_sql_detail_survives_unavailable_knowledge(self, upstream, configured):
        self.rows.return_value = [self.row(51)]
        result = app.history(51)
        self.assertTrue(result['has_alarm'])
        self.assertTrue(result['knowledge_unavailable'])
        self.assertEqual(result['alarm']['history_id'], '51')

    def test_database_failure_is_graceful(self):
        self.query.side_effect = RuntimeError('database offline')
        with self.assertLogs('app', level='ERROR') as logs:
            history_response = app.history_list(50, None)
            pareto_response = app.pareto('24h')
        self.assertEqual(history_response.status_code,503)
        self.assertEqual(pareto_response.status_code,503)
        self.assertIn('database offline', '\n'.join(logs.output))
        self.assertIn('before=None', logs.output[0])
        self.assertIn('window=24h', logs.output[1])
        self.assertTrue(all(record.exc_info for record in logs.records))
        self.assertNotIn(b'database offline', history_response.body)
        self.assertNotIn(b'database offline', pareto_response.body)

class SqlAggregationFixtureTests(unittest.TestCase):
    def test_real_grouping_and_window_boundaries(self):
        # Execute the GROUP BY/ORDER BY on SQLite fixtures. Translate only SQL
        # Server clock/date/count syntax; this is not a live SQL Server test.
        import sqlite3
        from datetime import timedelta
        from contextlib import contextmanager
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute("ATTACH DATABASE ':memory:' AS dbo")
        db.execute(PRODUCTION_SCHEMA)
        now = datetime(2026, 9, 19, 12)
        events = [(1,'A/B/Same',1), (1,'A/B/Same',2), (2,'A/C/Same',3),
                  (3,'A/D/Older',25), (4,'A/D/Week',100), (5,'A/D/Month',500),
                  (6,'A/D/Excluded',721), (7,'A/D/Future',-1)]
        for aid, path, age in events:
            db.execute('INSERT INTO dbo.Alarm_History(AlarmId,TagPath,CreatedTime) VALUES(?,?,?)',
                       (aid,path,(now-timedelta(hours=age)).isoformat()))
        class Cursor:
            def execute(self, sql, offset):
                sql = sql.replace('DECLARE @end datetime = GETDATE();','')
                sql = sql.replace('COUNT_BIG(*)','COUNT(*)')
                sql = sql.replace('DATEADD(hour, ?, @end)','?').replace('@end','?')
                return db.execute(sql, ((now+timedelta(hours=offset)).isoformat(),now.isoformat()))
        class Connection:
            def cursor(self): return Cursor()
        @contextmanager
        def fixture(): yield Connection()
        with patch('history_store.connection',fixture):
            for window, expected in [('24h',3), ('48h',4), ('1w',5), ('1m',6)]:
                result = store.pareto(window)
                self.assertEqual(result['total'],expected)
                self.assertEqual(result['alarms'][0]['count'],2)
                self.assertEqual(result['alarms'][0]['alarm_id'],1)
                self.assertEqual(result['alarms'][1]['alarm_id'],2)
                self.assertAlmostEqual(result['alarms'][0]['percentage'],200/expected)
                self.assertEqual(result['alarms'][-1]['cumulative_percentage'],100)

class ProductionHistorySchemaTests(unittest.TestCase):
    def test_history_queries_execute_without_alarm_lists_or_extra_columns(self):
        import sqlite3
        from contextlib import contextmanager
        db = sqlite3.connect(':memory:', detect_types=sqlite3.PARSE_DECLTYPES)
        self.addCleanup(db.close)
        db.execute("ATTACH DATABASE ':memory:' AS dbo")
        db.execute(PRODUCTION_SCHEMA)
        for history_id in range(1, 106):
            db.execute("INSERT INTO dbo.Alarm_History(HistoryId,AlarmId,TagId,TagPath,CurrentValue,CreatedTime) VALUES(?,?,?,?,?,?)",
                       (history_id,7,8,'CB_MODBUS/MIX/ALM/CementFeed_ALM',1.5,datetime(2026,9,19,10)))
        queries = []
        class Cursor:
            def execute(self, sql, *params):
                queries.append(sql)
                sql = sql.replace('TOP (?) ', '') + ' LIMIT ?'
                return db.execute(sql, (*params[1:], params[0]))
        class Connection:
            def cursor(self): return Cursor()
        @contextmanager
        def fixture(): yield Connection()
        with patch('history_store.connection',fixture):
            first = store.history_page()
            second = store.history_page(before=int(first['next_cursor']))
            third = store.history_page(before=int(second['next_cursor']))
            self.assertEqual([len(p['alarms']) for p in [first,second,third]], [50,50,5])
            ids = [int(a['history_id']) for p in [first,second,third] for a in p['alarms']]
            self.assertEqual(ids,list(range(105,0,-1)))
            self.assertIsNone(third['next_cursor'])
            selected = store.history_page(1, history_id=55)['alarms'][0]
            self.assertEqual(selected['tag_name'],'CementFeed_ALM')
            self.assertEqual(selected['kepware_path'],'CB_MODBUS.MIX.ALM.CementFeed_ALM')
            self.assertEqual(selected['value'],1.5)
            self.assertEqual(selected['activated_at'],'2026-09-19T10:00:00')
            self.assertEqual(selected['state'],'UNKNOWN')
            self.assertEqual(selected['priority'],0)
            self.assertEqual(store.history_page(before=1)['alarms'],[])
        for sql in queries:
            for forbidden in ['Alarm_Lists', 'Priority', 'ActivatedTime', 'ClearedTime', 'State', 'KepwarePath', 'TagName']:
                self.assertNotIn(forbidden,sql)

    @patch('history_store.configured', return_value=True)
    @patch('history_store.history_page', side_effect=RuntimeError('driver-specific SQL detail'))
    def test_fallback_failure_logs_exception_but_returns_upstream_response(self, page, configured):
        response = app.JSONResponse({'error':'OpcTagManager is unavailable.'},status_code=503)
        with self.assertLogs('app',level='ERROR') as logs:
            self.assertIs(app.sql_detail_fallback(response,55),response)
        self.assertIn('history_id=55',logs.output[0])
        self.assertIn('driver-specific SQL detail',logs.output[0])
        self.assertNotIn(b'driver-specific',response.body)

class ConfigurationTests(unittest.TestCase):
    @patch.dict('os.environ', {'ALARM_HELP_SQL_CONNECTION_STRING':'explicit'}, clear=True)
    def test_explicit_connection_precedes_reuse(self):
        self.assertEqual(store.connection_string(),'explicit')

    @patch.dict('os.environ', {'ALARM_HELP_SQL_ENV_FILE':'settings.env'}, clear=True)
    @patch('history_store.dotenv_values')
    @patch('pyodbc.drivers', return_value=['ODBC Driver 17 for SQL Server','ODBC Driver 18 for SQL Server'])
    def test_reused_settings_escape_values_and_preserve_tls(self, drivers, values):
        values.return_value = dict(SQL_SERVER='host',SQL_DB='db',SQL_USER='reader',
                                   SQL_PASS='abc};def',SQL_DRIVER='AUTO',SQL_ENCRYPT='yes',
                                   SQL_TRUST_SERVER_CERTIFICATE='false')
        result = store.connection_string()
        self.assertIn('DRIVER={ODBC Driver 18 for SQL Server}',result)
        self.assertIn('PWD={abc}};def}',result)
        self.assertIn('Encrypt={yes}',result)
        self.assertIn('TrustServerCertificate={no}',result)

if __name__ == '__main__':
    unittest.main()
