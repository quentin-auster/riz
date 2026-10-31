<script lang="ts">
  import { page } from "$app/state";
</script>

{#if page.status === 403}
  <h1>Not permitted</h1>
  <p>Your account is not allowed to do this.</p>
{:else}
  <h1>{page.status}</h1>
  <p>{page.error?.message}</p>
{/if}
