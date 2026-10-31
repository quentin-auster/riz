<script lang="ts">
  let { data } = $props();
</script>

<h1>{data.application.name}</h1>
<dl>
  <dt>Environment</dt>
  <dd>{data.application.environment}</dd>
  <dt>Created</dt>
  <dd>{data.application.createdAt}</dd>
  <dt>Active model</dt>
  <dd>{data.active ? data.active.id : "None"}</dd>
</dl>

<p><a href={`/applications/${data.application.id}/relationships`}>Relationships</a></p>

<h2>Prior models</h2>
{#if data.prior.length === 0}
  <p>No prior models.</p>
{:else}
  <ul>
    {#each data.prior as model (model.id)}
      <li>{model.id} <small>{model.createdAt}</small></li>
    {/each}
  </ul>
{/if}
