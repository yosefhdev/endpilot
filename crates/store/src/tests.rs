use super::*;
use endpilot_core::model::{Auth, Scripts, Settings};

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn kv(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: value.into(),
        enabled: true,
    }
}

fn names(store: &Store, parent: Option<&str>) -> Vec<String> {
    store
        .snapshot()
        .unwrap()
        .items
        .into_iter()
        .filter(|i| i.parent_id.as_deref() == parent)
        .map(|i| i.name)
        .collect()
}

#[test]
fn migrations_are_idempotent_on_reopen() {
    let path = std::env::temp_dir().join(format!("endpilot-test-{}.db", new_id()));
    {
        let s = Store::open(&path).unwrap();
        s.create_collection("A").unwrap();
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.snapshot().unwrap().collections.len(), 1);
    drop(s);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn collection_crud() {
    let s = store();
    let c = s.create_collection("API").unwrap();
    let c2 = s.create_collection("Otra").unwrap();
    assert!(c2.sort > c.sort);

    let c = s
        .update_collection(&c.id, Some("API v2"), Some(&[kv("base", "http://x")]), None)
        .unwrap();
    assert_eq!(c.name, "API v2");
    assert_eq!(c.variables, vec![kv("base", "http://x")]);
    // Name-only update keeps variables.
    let c = s
        .update_collection(&c.id, Some("API v3"), None, None)
        .unwrap();
    assert_eq!(c.variables.len(), 1);

    s.delete_collection(&c.id).unwrap();
    let snap = s.snapshot().unwrap();
    assert_eq!(snap.collections.len(), 1);
    assert!(s.update_collection(&c.id, Some("x"), None, None).is_err());
}

#[test]
fn items_create_update_and_validate_parent() {
    let s = store();
    let c = s.create_collection("C").unwrap();
    let folder = s
        .create_item(&c.id, None, ItemKind::Folder, "Users", None)
        .unwrap();
    assert_eq!(folder.request, None);
    let req = s
        .create_item(&c.id, Some(&folder.id), ItemKind::Request, "List", None)
        .unwrap();
    assert_eq!(req.request, Some(RequestSpec::default()));

    // Cannot nest inside a request.
    assert!(
        s.create_item(&c.id, Some(&req.id), ItemKind::Request, "x", None)
            .is_err()
    );

    let spec = RequestSpec {
        method: "POST".into(),
        url: "{{base}}/users".into(),
        auth: Auth::Bearer {
            token: "{{token}}".into(),
        },
        ..Default::default()
    };
    let req = s
        .update_item(&req.id, Some("Create"), Some(&spec), None)
        .unwrap();
    assert_eq!(req.name, "Create");
    assert_eq!(req.request.as_ref(), Some(&spec));
    // Folders hold no request.
    assert!(s.update_item(&folder.id, None, Some(&spec), None).is_err());
}

#[test]
fn move_reorders_and_changes_collection() {
    let s = store();
    let c = s.create_collection("C").unwrap();
    let other = s.create_collection("D").unwrap();
    let a = s
        .create_item(&c.id, None, ItemKind::Request, "a", None)
        .unwrap();
    let b = s
        .create_item(&c.id, None, ItemKind::Request, "b", None)
        .unwrap();
    let f = s
        .create_item(&c.id, None, ItemKind::Folder, "f", None)
        .unwrap();
    let inner = s
        .create_item(&c.id, Some(&f.id), ItemKind::Request, "inner", None)
        .unwrap();

    // b before a.
    s.move_item(&b.id, &c.id, None, Some(&a.id)).unwrap();
    assert_eq!(names(&s, None), ["b", "a", "f"]);
    // a into folder f (end).
    s.move_item(&a.id, &c.id, Some(&f.id), None).unwrap();
    assert_eq!(names(&s, Some(&f.id)), ["inner", "a"]);
    // Folder into itself or its child is rejected.
    assert!(s.move_item(&f.id, &c.id, Some(&f.id), None).is_err());
    // Whole folder to another collection takes its children along.
    s.move_item(&f.id, &other.id, None, None).unwrap();
    let snap = s.snapshot().unwrap();
    let moved: Vec<_> = snap
        .items
        .iter()
        .filter(|i| i.collection_id == other.id)
        .map(|i| i.id.clone())
        .collect();
    assert!(moved.contains(&f.id) && moved.contains(&inner.id) && moved.contains(&a.id));
}

#[test]
fn duplicate_item_copies_subtree_after_original() {
    let s = store();
    let c = s.create_collection("C").unwrap();
    let f = s
        .create_item(&c.id, None, ItemKind::Folder, "f", None)
        .unwrap();
    s.create_item(&c.id, None, ItemKind::Request, "last", None)
        .unwrap();
    s.create_item(&c.id, Some(&f.id), ItemKind::Request, "child", None)
        .unwrap();

    let copy = s.duplicate_item(&f.id).unwrap();
    assert_eq!(copy.name, "f (copia)");
    assert_ne!(copy.id, f.id);
    assert_eq!(names(&s, None), ["f", "f (copia)", "last"]);
    assert_eq!(names(&s, Some(&copy.id)), ["child"]);
}

#[test]
fn duplicate_collection_copies_items_and_variables() {
    let s = store();
    let c = s.create_collection("C").unwrap();
    s.update_collection(&c.id, None, Some(&[kv("a", "1")]), None)
        .unwrap();
    let f = s
        .create_item(&c.id, None, ItemKind::Folder, "f", None)
        .unwrap();
    s.create_item(&c.id, Some(&f.id), ItemKind::Request, "r", None)
        .unwrap();

    let copy = s.duplicate_collection(&c.id).unwrap();
    assert_eq!(copy.name, "C (copia)");
    assert_eq!(copy.variables, vec![kv("a", "1")]);
    let snap = s.snapshot().unwrap();
    let copied: Vec<_> = snap
        .items
        .iter()
        .filter(|i| i.collection_id == copy.id)
        .collect();
    assert_eq!(copied.len(), 2);
    let folder = copied.iter().find(|i| i.kind == ItemKind::Folder).unwrap();
    let req = copied.iter().find(|i| i.kind == ItemKind::Request).unwrap();
    assert_eq!(req.parent_id.as_deref(), Some(folder.id.as_str()));
}

#[test]
fn delete_item_hides_subtree() {
    let s = store();
    let c = s.create_collection("C").unwrap();
    let f = s
        .create_item(&c.id, None, ItemKind::Folder, "f", None)
        .unwrap();
    let child = s
        .create_item(&c.id, Some(&f.id), ItemKind::Request, "r", None)
        .unwrap();
    s.delete_item(&f.id).unwrap();
    assert!(s.snapshot().unwrap().items.is_empty());
    assert!(s.update_item(&child.id, Some("x"), None, None).is_err());
    assert!(s.duplicate_item(&f.id).is_err());
}

#[test]
fn environments_globals_and_active() {
    let s = store();
    let dev = s.create_environment("Dev").unwrap();
    s.update_environment(&dev.id, None, Some(&[kv("host", "localhost")]))
        .unwrap();
    s.set_globals(&[kv("g", "1")]).unwrap();
    s.set_active_environment(Some(&dev.id)).unwrap();

    let snap = s.snapshot().unwrap();
    assert_eq!(
        snap.environments[0].variables,
        vec![kv("host", "localhost")]
    );
    assert_eq!(snap.globals, vec![kv("g", "1")]);
    assert_eq!(snap.active_environment_id.as_deref(), Some(dev.id.as_str()));

    // Deleting the active environment clears the selection.
    s.delete_environment(&dev.id).unwrap();
    let snap = s.snapshot().unwrap();
    assert!(snap.environments.is_empty());
    assert_eq!(snap.active_environment_id, None);
    assert!(s.update_environment(&dev.id, Some("x"), None).is_err());
}

#[test]
fn history_is_newest_first_and_capped() {
    let s = store();
    let entry = |url: &str| HistoryEntry {
        id: String::new(),
        created_at: 0,
        request: RequestSpec {
            url: url.into(),
            ..Default::default()
        },
        status: Some(200),
        duration_ms: Some(12.5),
        size: Some(10),
        error: None,
    };
    for i in 0..(HISTORY_LIMIT + 5) {
        s.add_history(entry(&format!("http://x/{i}"))).unwrap();
    }
    let list = s.list_history().unwrap();
    assert_eq!(list.len() as i64, HISTORY_LIMIT);
    assert_eq!(
        list[0].request.url,
        format!("http://x/{}", HISTORY_LIMIT + 4)
    );
    s.clear_history().unwrap();
    assert!(s.list_history().unwrap().is_empty());
}

#[test]
fn import_and_export_collection_tree() {
    use endpilot_core::model::{CollectionTree, TreeItem};
    let s = store();
    let req = |url: &str| RequestSpec {
        url: url.into(),
        ..Default::default()
    };
    let tree = CollectionTree {
        name: "Importada".into(),
        variables: vec![kv("base", "http://x")],
        settings: Settings {
            auth: Auth::Bearer {
                token: "{{t}}".into(),
            },
            ..Default::default()
        },
        items: vec![
            TreeItem::Folder {
                name: "F".into(),
                settings: Settings {
                    auth: Auth::None,
                    ..Default::default()
                },
                items: vec![
                    TreeItem::Request {
                        name: "a".into(),
                        request: req("/a"),
                    },
                    TreeItem::Folder {
                        name: "vacía".into(),
                        settings: Settings::default(),
                        items: vec![],
                    },
                ],
            },
            TreeItem::Request {
                name: "b".into(),
                request: req("/b"),
            },
        ],
    };
    let c = s.import_collection(&tree).unwrap();
    assert_eq!(c.variables, tree.variables);
    assert_eq!(s.snapshot().unwrap().items.len(), 4);
    assert_eq!(s.export_collection(&c.id).unwrap(), tree);
}

#[test]
fn collection_and_folder_settings() {
    let s = store();
    let c = s.create_collection("API").unwrap();
    assert_eq!(c.settings, Settings::default());
    let settings = Settings {
        auth: Auth::Bearer {
            token: "{{token}}".into(),
        },
        scripts: Scripts {
            pre_request: "console.log(1)".into(),
            post_response: String::new(),
            blocked: false,
        },
    };
    let c = s
        .update_collection(&c.id, None, None, Some(&settings))
        .unwrap();
    assert_eq!(c.settings, settings);

    let folder = s
        .create_item(&c.id, None, ItemKind::Folder, "F", None)
        .unwrap();
    assert_eq!(folder.settings, Some(Settings::default()));
    let folder = s
        .update_item(&folder.id, None, None, Some(&settings))
        .unwrap();
    assert_eq!(folder.settings, Some(settings.clone()));

    let req = s
        .create_item(&c.id, None, ItemKind::Request, "r", None)
        .unwrap();
    assert_eq!(req.settings, None);
    assert!(s.update_item(&req.id, None, None, Some(&settings)).is_err());
}

#[test]
fn approve_scripts_unblocks_the_whole_collection() {
    use endpilot_core::model::{CollectionTree, TreeItem};
    let s = store();
    let blocked = Scripts {
        pre_request: "x()".into(),
        post_response: String::new(),
        blocked: true,
    };
    let settings = Settings {
        scripts: blocked.clone(),
        ..Default::default()
    };
    let c = s
        .import_collection(&CollectionTree {
            name: "C".into(),
            variables: vec![],
            settings: settings.clone(),
            items: vec![TreeItem::Folder {
                name: "F".into(),
                settings,
                items: vec![TreeItem::Request {
                    name: "r".into(),
                    request: RequestSpec {
                        scripts: blocked,
                        ..Default::default()
                    },
                }],
            }],
        })
        .unwrap();
    s.approve_scripts(&c.id).unwrap();
    let snap = s.snapshot().unwrap();
    assert!(!snap.collections[0].settings.scripts.blocked);
    for item in &snap.items {
        let scripts = match &item.request {
            Some(r) => &r.scripts,
            None => &item.settings.as_ref().unwrap().scripts,
        };
        assert!(!scripts.blocked, "{} still blocked", item.name);
        assert_eq!(scripts.pre_request, "x()");
    }
}
