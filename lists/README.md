# Repository-shipped standard lists

Only redistributable list data belongs in this directory. Each list is a
`<id>.json` manifest next to the data file it names:

```json
{
  "id": "example-premium-sites",
  "name": "Example Premium Sites",
  "kind": "allow",
  "scope": "domain",
  "file": "example-premium-sites.csv",
  "description": "Optional one-line description shown in the picker."
}
```

- `kind` is `allow` or `block`; `scope` is `domain` or `app_bundle`.
- The data file is one entry per line (a header row is tolerated; a UTF-8
  BOM is stripped).
- The two `example-*` lists here are synthetic placeholders so the picker has
  something to show. Replace them with your own lists or delete them.

## Private lists

Proprietary or vendor-licensed lists must be provisioned into
`DATA_DIR/lists` at deployment time; they must never be committed, even to a
private fork. An operator installs a directory of manifest + data pairs with:

```bash
sudo PRIVATE_LIST_SHA256_MY_BLOCK_LIST='<approved sha256>' \
  /opt/deal-onboarding/scripts/provision-private-lists.sh /secure/list-source /opt/deal-onboarding/data
sudo chown -R deal-onboarding:deal-onboarding /opt/deal-onboarding/data/lists
sudo systemctl restart deal-onboarding
```

The runtime loader merges `DATA_DIR/lists` with this directory (a repo id wins
on collision). Startup and the list API are the verification boundary: if a
private pair is malformed, it is not offered to traders. Trader-created lists
("save as a standard list") also land in `DATA_DIR/lists`, which every deploy
`rsync --delete` excludes.

## External-publication gate

Deleting a file in a normal commit does **not** erase it from Git history.
Before a fork or mirror that once carried private list data is shared, an
owner must purge the historical paths with `git filter-repo` and verify the
objects are unreachable.
