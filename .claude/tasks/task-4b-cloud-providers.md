# Task 4B: Cloud Provider Adapters

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 4C
**Blocked By:** 4A

## Objective
Build provider-specific adapter modules for AWS, Azure, and GCP that each implement a common interface for fetching cloud instances. Each adapter normalizes provider-specific instance data into a standardized format that the sync service can consume.

## Deliverables

### Provider Interface
- `/backend/src/providers/BaseProvider.js` — abstract base class defining the provider contract:
  - `constructor(credentials, regions, filters)` — initialize with decrypted credentials
  - `fetchInstances()` — returns array of standardized instance objects
  - `testConnection()` — validates credentials, returns { success, message }
  - `getRegions()` — returns list of available regions for the provider

### Standardized Instance Format
```js
{
  cloud_instance_id: string,    // provider-specific ID (i-xxx, /subscriptions/..., etc.)
  cloud_provider: string,       // "aws" | "azure" | "gcp"
  cloud_region: string,         // normalized region name
  cloud_account_id: string,     // AWS account ID, Azure subscription, GCP project
  hostname: string,             // instance name/tag
  ip_address: string,           // private IP (preferred) or public IP
  public_ip: string | null,     // public IP if assigned
  os_type: string | null,       // "linux" or "windows" from platform info
  instance_type: string,        // t3.micro, Standard_B2s, e2-medium, etc.
  state: string,                // "running", "stopped", "terminated"
  labels: object,               // tags/labels from the provider
  raw: object                   // original provider response for debugging
}
```

### AWS Adapter
- `/backend/src/providers/AwsProvider.js`:
  - Uses @aws-sdk/client-ec2 (v3)
  - Credentials: { accessKeyId, secretAccessKey, sessionToken? }
  - fetchInstances(): EC2 DescribeInstances across configured regions, flatten reservations, map to standard format
  - Handles pagination (NextToken)
  - Filter by instance state (running/stopped), tag filters from connector config
  - Maps Name tag to hostname, platform to os_type

### Azure Adapter
- `/backend/src/providers/AzureProvider.js`:
  - Uses @azure/arm-compute and @azure/identity
  - Credentials: { tenantId, clientId, clientSecret, subscriptionId }
  - fetchInstances(): list virtual machines across configured regions/resource groups
  - Maps computerName to hostname, network interfaces to IP addresses
  - Handles VM power state mapping to standardized state

### GCP Adapter
- `/backend/src/providers/GcpProvider.js`:
  - Uses @google-cloud/compute
  - Credentials: { projectId, serviceAccountKey (JSON) }
  - fetchInstances(): aggregatedList across configured zones
  - Maps instance name to hostname, networkInterfaces to IP addresses
  - Handles instance status mapping (RUNNING, STOPPED, TERMINATED)

### Provider Factory
- `/backend/src/providers/index.js` — `getProvider(providerType, credentials, regions, filters)` factory function returning the appropriate adapter instance

## Acceptance Criteria
- All three providers implement the same interface (fetchInstances, testConnection, getRegions)
- fetchInstances returns instances in the standardized format regardless of provider
- AWS adapter handles multi-region scanning and pagination correctly
- Azure adapter resolves network interface IPs (requires additional API call)
- GCP adapter handles zone-to-region mapping correctly
- testConnection validates credentials without fetching full instance lists (use a lightweight API call)
- Invalid credentials return a clear error message, not a raw SDK exception
- All providers handle rate limiting gracefully (retry with backoff)
- Provider factory throws descriptive error for unknown provider types
- Raw provider response is preserved in the `raw` field for debugging but not stored in the database
