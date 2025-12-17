/*
 * electric_poc.c - POC for point-in-time reads using MVCC snapshots
 */

#include "postgres.h"
#include "fmgr.h"
#include "utils/builtins.h"
#include "utils/jsonb.h"
#include "utils/snapmgr.h"
#include "utils/snapshot.h"
#include "executor/spi.h"
#include "lib/stringinfo.h"
#include "utils/datum.h"
#include "catalog/pg_type.h"
#include "utils/lsyscache.h"
#include "utils/memutils.h"
#include "access/xact.h"

#include <ctype.h>
#include <string.h>
#include <stdlib.h>

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(electric_exec_as_of);

/*
 * Check if the SQL starts with SELECT
 */
static bool
is_select_query(const char *sql)
{
    const char *p = sql;
    while (*p && isspace((unsigned char) *p))
        p++;
    if (pg_strncasecmp(p, "select", 6) == 0)
    {
        char next = p[6];
        if (next == '\0' || isspace((unsigned char) next))
            return true;
    }
    if (pg_strncasecmp(p, "with", 4) == 0)
    {
        char next = p[4];
        if (next == '\0' || isspace((unsigned char) next))
            return true;
    }
    return false;
}

/*
 * Parse JSON array of strings into an array of C strings
 */
static char **
parse_jsonb_args(Jsonb *jb, int *nargs)
{
    JsonbIterator *it;
    JsonbValue  v;
    JsonbIteratorToken type;
    char      **args;
    int         count = 0;
    int         alloc = 8;

    *nargs = 0;

    if (jb == NULL || JB_ROOT_IS_SCALAR(jb))
        return NULL;

    if (!JB_ROOT_IS_ARRAY(jb))
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
                 errmsg("args must be a JSON array")));

    args = (char **) palloc(alloc * sizeof(char *));

    it = JsonbIteratorInit(&jb->root);
    while ((type = JsonbIteratorNext(&it, &v, false)) != WJB_DONE)
    {
        if (type == WJB_ELEM)
        {
            char *str_val;

            if (count >= alloc)
            {
                alloc *= 2;
                args = (char **) repalloc(args, alloc * sizeof(char *));
            }

            switch (v.type)
            {
                case jbvString:
                    str_val = pnstrdup(v.val.string.val, v.val.string.len);
                    break;
                case jbvNumeric:
                    str_val = DatumGetCString(DirectFunctionCall1(numeric_out,
                                              NumericGetDatum(v.val.numeric)));
                    break;
                case jbvBool:
                    str_val = pstrdup(v.val.boolean ? "true" : "false");
                    break;
                case jbvNull:
                    str_val = NULL;
                    break;
                default:
                    ereport(ERROR,
                            (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
                             errmsg("unsupported JSON value type in args array")));
            }

            args[count++] = str_val;
        }
    }

    *nargs = count;
    return args;
}

/*
 * Parse snapshot string and create a custom MVCC snapshot.
 * Format: xmin:xmax:xip1,xip2,...
 */
static Snapshot
create_custom_snapshot(const char *snapshot_str)
{
    Snapshot    base;
    Snapshot    snap;
    char       *str_copy;
    char       *token;
    char       *saveptr;
    char       *xip_str;
    char       *p;
    TransactionId xmin, xmax;
    TransactionId *xip = NULL;
    uint32      xcnt = 0;
    uint32      xip_alloc = 0;
    Size        size;

    str_copy = pstrdup(snapshot_str);

    /* Parse xmin */
    token = strtok_r(str_copy, ":", &saveptr);
    if (token == NULL)
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
                 errmsg("malformed snapshot: missing xmin")));
    xmin = (TransactionId) strtoul(token, NULL, 10);

    /* Parse xmax */
    token = strtok_r(NULL, ":", &saveptr);
    if (token == NULL)
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
                 errmsg("malformed snapshot: missing xmax")));
    xmax = (TransactionId) strtoul(token, NULL, 10);

    /* Parse xip list (may be empty) */
    xip_str = strtok_r(NULL, ":", &saveptr);
    if (xip_str != NULL && strlen(xip_str) > 0)
    {
        char *xip_copy;
        char *xip_saveptr;
        char *xip_token;

        /* Count commas to estimate array size */
        xip_alloc = 1;
        for (p = xip_str; *p; p++)
            if (*p == ',')
                xip_alloc++;

        xip = (TransactionId *) palloc(xip_alloc * sizeof(TransactionId));

        xip_copy = pstrdup(xip_str);
        xip_token = strtok_r(xip_copy, ",", &xip_saveptr);
        while (xip_token != NULL)
        {
            if (strlen(xip_token) > 0)
                xip[xcnt++] = (TransactionId) strtoul(xip_token, NULL, 10);
            xip_token = strtok_r(NULL, ",", &xip_saveptr);
        }
        pfree(xip_copy);
    }

    pfree(str_copy);

    /* Get the current transaction's snapshot as a base */
    base = GetTransactionSnapshot();

    /* Allocate our custom snapshot - include space for xip array */
    size = sizeof(SnapshotData) + (xcnt * sizeof(TransactionId));
    snap = (Snapshot) MemoryContextAllocZero(TopTransactionContext, size);

    /* Copy base snapshot structure */
    memcpy(snap, base, sizeof(SnapshotData));

    /* Override with our custom values */
    snap->xmin = xmin;
    snap->xmax = xmax;
    snap->xcnt = xcnt;
    snap->copied = true;
    snap->active_count = 0;
    snap->regd_count = 0;

    /* Set xip to point after SnapshotData */
    if (xcnt > 0)
    {
        snap->xip = (TransactionId *) ((char *) snap + sizeof(SnapshotData));
        memcpy(snap->xip, xip, xcnt * sizeof(TransactionId));
        pfree(xip);
    }
    else
    {
        snap->xip = NULL;
    }

    /* Clear subxip (not tracking subtransactions in POC) */
    snap->subxip = NULL;
    snap->subxcnt = 0;
    snap->suboverflowed = false;

    return snap;
}

Datum
electric_exec_as_of(PG_FUNCTION_ARGS)
{
    Datum       snapshot_datum = PG_GETARG_DATUM(0);
    text       *sql_text = PG_GETARG_TEXT_PP(1);
    Jsonb      *args_jsonb = PG_ARGISNULL(2) ? NULL : PG_GETARG_JSONB_P(2);
    char       *sql;
    char       *snapshot_str;
    StringInfoData wrapped_sql;
    int         ret;
    Datum       result;
    bool        isnull;
    char      **args = NULL;
    int         nargs = 0;
    Oid        *argtypes = NULL;
    Datum      *argvalues = NULL;
    char       *nulls = NULL;
    int         i;
    Snapshot    custom_snap;

    /* Convert pg_snapshot to text string using the output function */
    {
        Oid         snapshot_typoid;
        Oid         typoutput;
        bool        typIsVarlena;
        
        snapshot_typoid = get_fn_expr_argtype(fcinfo->flinfo, 0);
        getTypeOutputInfo(snapshot_typoid, &typoutput, &typIsVarlena);
        snapshot_str = OidOutputFunctionCall(typoutput, snapshot_datum);
    }

    /* Get SQL */
    sql = text_to_cstring(sql_text);

    if (!is_select_query(sql))
        ereport(ERROR,
                (errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
                 errmsg("only SELECT queries are allowed"),
                 errhint("The query must start with SELECT or WITH")));

    /* Parse args */
    if (args_jsonb != NULL)
        args = parse_jsonb_args(args_jsonb, &nargs);

    /* Build wrapped SQL */
    initStringInfo(&wrapped_sql);
    appendStringInfo(&wrapped_sql,
                     "SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::jsonb FROM (%s) q",
                     sql);

    /* Connect to SPI */
    if (SPI_connect() != SPI_OK_CONNECT)
        ereport(ERROR,
                (errcode(ERRCODE_INTERNAL_ERROR),
                 errmsg("SPI_connect failed")));

    /* Create custom snapshot from the provided pg_snapshot */
    custom_snap = create_custom_snapshot(snapshot_str);

    /* Push our custom snapshot */
    PushActiveSnapshot(custom_snap);

    PG_TRY();
    {
        if (nargs > 0)
        {
            argtypes = (Oid *) palloc(nargs * sizeof(Oid));
            argvalues = (Datum *) palloc(nargs * sizeof(Datum));
            nulls = (char *) palloc(nargs * sizeof(char));

            for (i = 0; i < nargs; i++)
            {
                argtypes[i] = TEXTOID;
                if (args[i] != NULL)
                {
                    argvalues[i] = CStringGetTextDatum(args[i]);
                    nulls[i] = ' ';
                }
                else
                {
                    argvalues[i] = (Datum) 0;
                    nulls[i] = 'n';
                }
            }

            ret = SPI_execute_with_args(wrapped_sql.data,
                                        nargs,
                                        argtypes,
                                        argvalues,
                                        nulls,
                                        true,
                                        0);
        }
        else
        {
            ret = SPI_execute(wrapped_sql.data, true, 0);
        }

        if (ret != SPI_OK_SELECT)
            ereport(ERROR,
                    (errcode(ERRCODE_INTERNAL_ERROR),
                     errmsg("SPI_execute failed: %s", SPI_result_code_string(ret))));

        if (SPI_processed != 1)
            ereport(ERROR,
                    (errcode(ERRCODE_INTERNAL_ERROR),
                     errmsg("expected 1 result row, got %lu", (unsigned long) SPI_processed)));

        result = SPI_getbinval(SPI_tuptable->vals[0],
                               SPI_tuptable->tupdesc,
                               1,
                               &isnull);

        if (isnull)
            result = DirectFunctionCall1(jsonb_in, CStringGetDatum("[]"));
        else
            result = datumCopy(result, false, -1);
    }
    PG_FINALLY();
    {
        PopActiveSnapshot();
        SPI_finish();
    }
    PG_END_TRY();

    PG_RETURN_DATUM(result);
}
