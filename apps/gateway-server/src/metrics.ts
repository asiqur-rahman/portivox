type CounterName =
  | "gateway_requests_total"
  | "gateway_request_errors_total"
  | "gateway_ws_connections_total"
  | "gateway_ws_auth_failures_total"
  | "gateway_active_tunnels"
  | "gateway_chunk_frames_total"
  | "gateway_chunk_reassembled_streams_total"
  | "gateway_chunk_incomplete_timeouts_total";

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export class GatewayMetrics {
  private readonly counters = new Map<string, number>();
  private readonly labeledCounters = new Map<string, number>();
  private readonly latencyBuckets = new Map<number, number>();
  private latencySum = 0;
  private latencyCount = 0;

  constructor() {
    for (const bucket of DEFAULT_BUCKETS) {
      this.latencyBuckets.set(bucket, 0);
    }
  }

  increment(name: CounterName, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  incrementLabeled(name: string, labels: Record<string, string>, value = 1): void {
    const key = `${name}{${serializeLabels(labels)}}`;
    this.labeledCounters.set(key, (this.labeledCounters.get(key) ?? 0) + value);
  }

  setGauge(name: "gateway_active_tunnels", value: number): void {
    this.counters.set(name, value);
  }

  observeRequestLatency(durationMs: number): void {
    this.latencySum += durationMs;
    this.latencyCount += 1;
    for (const bucket of DEFAULT_BUCKETS) {
      if (durationMs <= bucket) {
        this.latencyBuckets.set(bucket, (this.latencyBuckets.get(bucket) ?? 0) + 1);
      }
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];

    lines.push("# HELP gateway_requests_total Total inbound gateway requests");
    lines.push("# TYPE gateway_requests_total counter");
    lines.push(`gateway_requests_total ${this.counters.get("gateway_requests_total") ?? 0}`);

    lines.push("# HELP gateway_request_errors_total Total gateway request errors");
    lines.push("# TYPE gateway_request_errors_total counter");
    lines.push(`gateway_request_errors_total ${this.counters.get("gateway_request_errors_total") ?? 0}`);

    lines.push("# HELP gateway_requests_labeled_total Gateway requests by endpoint/method/status_class");
    lines.push("# TYPE gateway_requests_labeled_total counter");
    appendMetricLines(lines, this.labeledCounters, "gateway_requests_labeled_total");

    lines.push("# HELP gateway_errors_labeled_total Gateway errors by endpoint/error_code");
    lines.push("# TYPE gateway_errors_labeled_total counter");
    appendMetricLines(lines, this.labeledCounters, "gateway_errors_labeled_total");

    lines.push("# HELP gateway_ws_connections_total Total websocket connections accepted");
    lines.push("# TYPE gateway_ws_connections_total counter");
    lines.push(`gateway_ws_connections_total ${this.counters.get("gateway_ws_connections_total") ?? 0}`);

    lines.push("# HELP gateway_ws_auth_failures_total Total websocket auth failures");
    lines.push("# TYPE gateway_ws_auth_failures_total counter");
    lines.push(`gateway_ws_auth_failures_total ${this.counters.get("gateway_ws_auth_failures_total") ?? 0}`);

    lines.push("# HELP gateway_active_tunnels Active local tunnels on this gateway node");
    lines.push("# TYPE gateway_active_tunnels gauge");
    lines.push(`gateway_active_tunnels ${this.counters.get("gateway_active_tunnels") ?? 0}`);

    lines.push("# HELP gateway_chunk_frames_total Total chunk frames received from tunnel clients");
    lines.push("# TYPE gateway_chunk_frames_total counter");
    lines.push(`gateway_chunk_frames_total ${this.counters.get("gateway_chunk_frames_total") ?? 0}`);

    lines.push("# HELP gateway_chunk_reassembled_streams_total Total chunked streams successfully reassembled");
    lines.push("# TYPE gateway_chunk_reassembled_streams_total counter");
    lines.push(`gateway_chunk_reassembled_streams_total ${this.counters.get("gateway_chunk_reassembled_streams_total") ?? 0}`);

    lines.push("# HELP gateway_chunk_incomplete_timeouts_total Total chunked streams timed out before completion");
    lines.push("# TYPE gateway_chunk_incomplete_timeouts_total counter");
    lines.push(`gateway_chunk_incomplete_timeouts_total ${this.counters.get("gateway_chunk_incomplete_timeouts_total") ?? 0}`);

    lines.push("# HELP gateway_tunnel_request_duration_ms Tunnel request duration in milliseconds");
    lines.push("# TYPE gateway_tunnel_request_duration_ms histogram");
    for (const bucket of DEFAULT_BUCKETS) {
      lines.push(`gateway_tunnel_request_duration_ms_bucket{le="${bucket}"} ${this.latencyBuckets.get(bucket) ?? 0}`);
    }
    lines.push(`gateway_tunnel_request_duration_ms_bucket{le="+Inf"} ${this.latencyCount}`);
    lines.push(`gateway_tunnel_request_duration_ms_sum ${this.latencySum}`);
    lines.push(`gateway_tunnel_request_duration_ms_count ${this.latencyCount}`);

    return `${lines.join("\n")}\n`;
  }
}

function serializeLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function appendMetricLines(lines: string[], source: Map<string, number>, metricName: string): void {
  const entries = [...source.entries()]
    .filter(([key]) => key.startsWith(`${metricName}{`))
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    lines.push(`${metricName}{endpoint="none"} 0`);
    return;
  }

  for (const [key, value] of entries) {
    lines.push(`${key} ${value}`);
  }
}
