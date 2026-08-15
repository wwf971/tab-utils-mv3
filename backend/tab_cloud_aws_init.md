# Initialize AWS storage for Tab Cloud

Tab Cloud uses six DynamoDB tables. DynamoDB is the source of truth for remote windows, tabs, tags, groups, trash, and pending index work.

The normal initialization path is:

```text
backend AWS config
  -> backend /api/maintenance/awsInit
       -> create six missing DynamoDB tables
       -> create the missing Elasticsearch index
  -> Check Tables
       -> every table is ACTIVE
       -> the Elasticsearch index exists
```

Use the backend **Initialize** action when possible. It creates the exact key and index schemas expected by the code. Manual table creation is described below for cases where the backend identity is not allowed to create tables.

## Required DynamoDB structure

With the default `table_name_prefix: TabCloud`, the tables are:

```text
TabCloudWindow
TabCloudTab
TabCloudTag
TabCloudTabTag
TabCloudGroup
TabCloudMeta
```

The prefix is joined directly to each suffix. A prefix such as `TabCloudDev` produces `TabCloudDevWindow`, `TabCloudDevTab`, and so on.

All key attributes use DynamoDB type **String**. There are no local secondary indexes.

### Window

```text
table:         TabCloudWindow
partition key: userId       String
sort key:      windowPath   String

global secondary index:
  name:         gsiWindowId
  partition key: id         String
  sort key:      none
  projection:    ALL
```

### Tab

```text
table:         TabCloudTab
partition key: userId     String
sort key:      tabPath    String

global secondary index:
  name:         gsiTabId
  partition key: id       String
  sort key:      none
  projection:    ALL
```

### Tag

```text
table:         TabCloudTag
partition key: userId    String
sort key:      tagName   String

global secondary index:
  name:         gsiTagId
  partition key: id      String
  sort key:      none
  projection:    ALL
```

### TabTag

```text
table:         TabCloudTabTag
partition key: tagId     String
sort key:      tabPath   String

global secondary index:
  name:         gsiTabTag
  partition key: tabId   String
  sort key:      tagId   String
  projection:    ALL
```

### Group

```text
table:         TabCloudGroup
partition key: userId   String
sort key:      id       String
global secondary indexes: none
```

### Meta

```text
table:         TabCloudMeta
partition key: userId    String
sort key:      metaPath  String
global secondary indexes: none
```

## Why every GSI uses `ALL`

A GSI projection controls which base-table attributes are copied into the index:

- `KEYS_ONLY` copies the table keys and index keys only.
- `INCLUDE` also copies a fixed list of selected attributes.
- `ALL` copies the complete item.

The backend queries `gsiWindowId`, `gsiTabId`, `gsiTagId`, and `gsiTabTag`, then directly uses the returned item. It does not perform a second base-table read for attributes omitted from the GSI. Therefore:

```text
required for this implementation: ALL
do not use:                       KEYS_ONLY or INCLUDE
```

`KEYS_ONLY` can make the index smaller, but the current backend would receive incomplete items. `INCLUDE` would require a carefully maintained attribute list and would break when backend logic starts reading another attribute. `ALL` also matches the schema created by `awsInit`.

## Common table settings

Use these settings for all six tables:

```text
capacity mode:       On-demand / PAY_PER_REQUEST
table class:         DynamoDB Standard
encryption at rest:  AWS owned key, unless another key is required
deletion protection: optional for development; recommended for real data
point-in-time recovery: optional for development; recommended for real data
TTL:                 disabled
DynamoDB Streams:    disabled
global tables:       not needed
```

On-demand capacity avoids choosing read/write capacity numbers before the workload is known.

Do not declare normal item fields such as `title`, `url`, `createAt`, or `color` while creating a table. DynamoDB is schema-less outside keys. Only table key and GSI key attributes belong in the key schema.

TTL must stay disabled unless a separate expiration design is added. Trashed items and pending journal items are deleted by backend logic, not by time-based DynamoDB expiration.

## Recommended initialization

### 1. Choose Region and table prefix

Choose one AWS Region and keep the backend configuration, IAM resource ARNs, and AWS Console Region identical.

Create or update `backend/config.0.yaml`:

```yaml
aws:
  region_name: ap-northeast-1
  dynamodb:
    table_name_prefix: TabCloud
```

`config.0.yaml` overrides `config.yaml` and is ignored by Git.

When the backend runs with an EC2, ECS, or other AWS role, let boto3 use that role:

```yaml
aws:
  region_name: ap-northeast-1
  access_key_id: null
  secret_access_key: null
  dynamodb:
    table_name_prefix: TabCloud
```

The explicit `null` values replace the example credentials from `config.yaml`. When the backend runs outside AWS and cannot use a role, use credentials from a dedicated IAM identity in `config.0.yaml`. Never use root-account credentials or commit real credentials.

### 2. Grant DynamoDB permissions

The backend identity needs these actions:

```text
Initialization:
  dynamodb:CreateTable
  dynamodb:DescribeTable

Normal operation:
  dynamodb:DescribeTable
  dynamodb:GetItem
  dynamodb:PutItem
  dynamodb:DeleteItem
  dynamodb:Query
  dynamodb:TransactWriteItems
```

An identity policy for a default `TabCloud` prefix can use:

```jsonc
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TabCloudDynamoDb",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:DescribeTable",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems"
      ],
      "Resource": [
        "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/TabCloud*",
        "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/TabCloud*/index/*"
      ]
    }
  ]
}
```

Replace `REGION`, `ACCOUNT_ID`, and the `TabCloud` prefix. After initialization, `dynamodb:CreateTable` can be removed if this identity should only use existing tables.

### 3. Make Elasticsearch reachable

`awsInit` initializes both DynamoDB and the configured Elasticsearch index. The Elasticsearch endpoint selected by `elasticsearch.endpoint_use` must be reachable from the backend.

Elasticsearch is not stored in these DynamoDB tables. It is a rebuildable search index; DynamoDB remains the source of truth.

### 4. Run Initialize

1. Start the backend with its real `config.0.yaml`.
2. Open the extension popup.
3. Open Remote settings and set the backend endpoint.
4. Log in.
5. Select **Check Tables** to see the initial state.
6. Select **Initialize**.
7. Wait until initialization finishes.
8. Select **Check Tables** again.

The operation is safe to retry. It skips tables and the Elasticsearch index that already exist.

Expected result:

```text
TabCloudWindow  ACTIVE
TabCloudTab     ACTIVE
TabCloudTag     ACTIVE
TabCloudTabTag  ACTIVE
TabCloudGroup   ACTIVE
TabCloudMeta    ACTIVE
Elasticsearch index: tab_cloud_tab  EXISTS
pending index journals: 0
```

The actual table prefix and Elasticsearch index name can differ according to config.

If Initialize reports an Elasticsearch error after creating the tables, fix Elasticsearch connectivity and retry. Existing DynamoDB tables are kept and skipped.

## Manual AWS Console creation

Use this path only when the backend identity cannot have `dynamodb:CreateTable`.

For each table:

1. Open **DynamoDB** in the AWS Console.
2. Confirm the selected Region matches `aws.region_name`.
3. Select **Tables** → **Create table**.
4. Enter the exact table name, partition key, and sort key from [Required DynamoDB structure](#required-dynamodb-structure).
5. Choose **Customize settings**.
6. Choose **On-demand** capacity.
7. For Window, Tab, Tag, and TabTag, add the specified global secondary index.
8. Set every GSI projection to **All**.
9. Keep TTL and DynamoDB Streams disabled.
10. Create the table and wait for table status **ACTIVE**.

Repeat until all six tables exist. Then use **Check Tables** in Remote settings.

Manual creation does not create the Elasticsearch index. After the six tables are active, the backend **Initialize** action can still create the missing index. It will skip the existing tables, so `dynamodb:CreateTable` is not needed when every table already exists.

## Verification and incorrect schemas

**Check Tables** currently checks only that each table exists and reports its table status. It does not validate table keys, GSI keys, or projection mode.

`awsInit` also skips an existing table. It does not repair an existing table with a wrong schema.

After manual creation, verify in the DynamoDB Console:

```text
all six tables are ACTIVE
all partition and sort key names match exactly, including letter case
all key types are String
all four GSI names and keys match exactly
all four GSI projections are ALL
capacity mode is On-demand
backend config uses the same Region and prefix
```

If an empty table was created with a wrong schema, delete that table and let **Initialize** recreate it, or recreate it manually with the exact schema. Do not delete a table that already contains wanted data; back it up and migrate the data instead.

For a final functional check, upload one tab, list its remote window, search for the tab, move it to trash, and restore it. This exercises normal table queries, GSI lookups, transactions, and the search index.
