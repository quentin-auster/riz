<script lang="ts">
  let { data } = $props();
</script>

<h1>Applications</h1>
<form method="GET">
  <input name="q" value={data.q} placeholder="Search" aria-label="Search applications" />
  <button type="submit">Search</button>
</form>

{#if data.items.length === 0}
  <p>No applications.</p>
{:else}
  <table>
    <thead>
      <tr><th>Name</th><th>Environment</th><th>Created</th></tr>
    </thead>
    <tbody>
      {#each data.items as app (app.id)}
        <tr>
          <td><a href={`/applications/${app.id}`}>{app.name}</a></td>
          <td>{app.environment}</td>
          <td>{app.createdAt}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if data.nextCursor}
  <a href={`?cursor=${encodeURIComponent(data.nextCursor)}`}>Next page</a>
{/if}
