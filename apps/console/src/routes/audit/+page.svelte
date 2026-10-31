<script lang="ts">
  let { data } = $props();
  const nextHref = $derived(
    data.nextCursor
      ? `?${new URLSearchParams({
          ...Object.fromEntries(Object.entries(data.filters).filter(([, v]) => v)),
          cursor: data.nextCursor,
        })}`
      : null,
  );
</script>

<h1>Audit log</h1>

<form method="GET">
  <input name="application" value={data.filters.application} placeholder="Application" aria-label="Application" />
  <input name="actor" value={data.filters.actor} placeholder="Actor" aria-label="Actor" />
  <input name="action" value={data.filters.action} placeholder="Action, e.g. models.rollback" aria-label="Action" />
  <input name="from" type="datetime-local" value={data.filters.from} aria-label="From (UTC)" />
  <input name="to" type="datetime-local" value={data.filters.to} aria-label="To (UTC)" />
  <button type="submit">Filter</button>
</form>
{#if data.filterError}<p role="alert">{data.filterError}</p>{/if}

{#if data.items.length === 0}
  <p>No audit events.</p>
{:else}
  <table>
    <thead>
      <tr><th>ID</th><th>Time</th><th>Actor</th><th>Action</th><th>Application</th><th>Request</th></tr>
    </thead>
    <tbody>
      {#each data.items as e (e.id)}
        <tr>
          <td>{e.id}</td>
          <td>{e.time}</td>
          <td>{e.actor}</td>
          <td>{e.action}</td>
          <td>{e.application ?? ""}</td>
          <td>{e.requestId ?? ""}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if nextHref}<a href={nextHref}>Next page</a>{/if}
