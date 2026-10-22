type DbClient = import("pg").PoolClient;

export async function enqueueInboundWebhookDeliveries(client: DbClient, eventId: string, workspaceId: string) {
  await client.query(
    `INSERT INTO webhook_deliveries (workspace_id, endpoint_id, event_id, payload)
     SELECT e.workspace_id, h.id, e.id,
       jsonb_build_object('id', e.id, 'type', e.event_type, 'workspaceId', e.workspace_id,
         'occurredAt', e.occurred_at, 'data', jsonb_build_object('complaintId', e.complaint_id))
     FROM complaint_activity_events e JOIN webhook_endpoints h ON h.workspace_id = e.workspace_id
     WHERE e.id = $1 AND e.workspace_id = $2 AND h.enabled = true AND h.deleted_at IS NULL
       AND e.event_type = ANY(h.event_types)
     ON CONFLICT (endpoint_id, event_id) DO NOTHING`, [eventId, workspaceId]
  );
}
