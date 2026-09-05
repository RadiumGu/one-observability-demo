import logging
import os
import psycopg
import config
import repository
from flask import Flask, jsonify

# Setup flask app
app = Flask(__name__)

logging.basicConfig(level=os.getenv('LOG_LEVEL', 20), format='%(message)s')
logger = logging.getLogger()
cfg = config.fetch_config()
conn_params = config.get_rds_connection_parameters(cfg['rds_secret_arn'], cfg['region'])
db = psycopg.connect(**conn_params)

def get_db():
    """返回可用的数据库连接，必要时先回滚、再重连。

    ⚠️ 原实现只捕获 psycopg.OperationalError，这漏掉了**失败事务**这一整类，
       导致连接一旦进入 INERROR 状态就永久不可用、且永远不会被重建。

       实测继承链（psycopg 3.2.5，取自运行中的容器）：
         InFailedSqlTransaction -> InternalError    -> DatabaseError -> Error
         OperationalError       -> DatabaseError                     -> Error
       两者是 DatabaseError 下的**兄弟分支** ——
       issubclass(InFailedSqlTransaction, OperationalError) 实测为 False，
       所以 `except psycopg.OperationalError` 抓不到它，异常向上逃出本函数，
       连接永不重建。

       真实发生过：一次 ALTER TABLE 打断了本进程持有的长连接上的事务，
       此后该 Pod 的所有请求（连 /health/status）全部 500，而 Pod 仍显示
       ready=true、RESTARTS=0。同一 Deployment 的另一个 Pod 因为重启过一次
       （连接已重建）返回 200 —— 两个 Pod 行为分裂正是定位此问题的判据。

    修法分两层：
      ① 先用 psycopg 自带的 TransactionStatus 判断连接是否处于失败事务，
         是则 rollback 就地救活 —— 这比重连便宜得多，也不丢连接池。
      ② 探测语句的 except 收敛到 psycopg.Error（覆盖 OperationalError、
         InterfaceError、InFailedSqlTransaction 等全部子类），
         回滚仍救不活才重连。
    """
    global db
    if db.closed:
        logger.warning('DB connection closed, reconnecting...')
        db = psycopg.connect(**conn_params)
        return db

    # ① 连接处于失败事务（INERROR）时，rollback 即可恢复，无需重连。
    #    这是 psycopg 显式提供的状态，比靠发探测语句去试更直接。
    try:
        if db.info.transaction_status == psycopg.pq.TransactionStatus.INERROR:
            logger.warning('DB connection in failed transaction, rolling back...')
            db.rollback()
    except psycopg.Error as exc:
        logger.warning('Rollback failed (%s), reconnecting...', type(exc).__name__)
        try:
            db.close()
        except Exception:
            pass
        db = psycopg.connect(**conn_params)
        return db

    # ② 探测。except 用 psycopg.Error 而不是 OperationalError ——
    #    后者会漏掉 InFailedSqlTransaction 与 InterfaceError。
    try:
        db.execute('SELECT 1')
    except psycopg.Error as exc:
        logger.warning('DB connection unusable (%s), reconnecting...', type(exc).__name__)
        try:
            db.rollback()
            db.execute('SELECT 1')          # 回滚后再试一次，能救活就不重连
            return db
        except psycopg.Error:
            pass
        try:
            db.close()
        except Exception:
            pass
        db = psycopg.connect(**conn_params)
    return db

@app.route('/petadoptionshistory/api/home/transactions', methods=['GET'])
def transactions_get():
    transactions = repository.list_transaction_history(get_db())
    return jsonify(transactions)

@app.route('/petadoptionshistory/api/home/transactions', methods=['DELETE'])
def transactions_delete():
    repository.delete_transaction_history(get_db())
    return jsonify(success=True)

@app.route('/health/status')
def status_path():
    repository.check_alive(get_db())
    return jsonify(success=True)
