import psycopg


# ⚠️ 这些函数原本只在**成功路径**上 db.commit()，一旦 execute() 抛异常，
#    既不 commit 也不 rollback —— 事务留在 INERROR 状态，
#    该长连接此后所有查询都被 PostgreSQL 拒绝：
#      psycopg.errors.InFailedSqlTransaction:
#        current transaction is aborted, commands ignored until end of transaction block
#    这就是「失败事务」的产生源头（get_db() 里的漏判只是让它无法自愈）。
#
#    真实发生过：一次 ALTER TABLE 打断了本进程持有的连接上的事务，
#    此后该 Pod 连 /health/status 都 500，而 Pod 仍显示 ready=true、RESTARTS=0。
#
#    修法：用 `with db.transaction()` 包起来 —— psycopg 3 的上下文管理器
#    在正常退出时提交、抛异常时**自动回滚**，从根上不留下 INERROR 连接。
#    异常仍向上抛（调用方需要知道失败），但连接本身保持可用。


def list_transaction_history(db):
    sql = 'SELECT * FROM transactions_history'

    with db.transaction():
        cur = db.cursor()
        cur.execute(sql)
        result = cur.fetchall()

    return result


def delete_transaction_history(db):
    sql = 'DELETE FROM transactions_history'

    with db.transaction():
        cur = db.cursor()
        result = cur.execute(sql)

    return result


def count_transaction_history(db):
    sql = 'SELECT count(*) FROM transactions_history'

    with db.transaction():
        cur = db.cursor()
        cur.execute(sql)
        result = cur.fetchone()

    return result[0]


def check_alive(db):
    sql = 'SELECT NULL'  # do nothing

    with db.transaction():
        cur = db.cursor()
        cur.execute(sql)
