//! Import → export → reimport must keep everything Endpilot models.

use endpilot_core::{
    http::{FormFieldKind, KeyValue, RawLanguage},
    model::{ApiKeyLocation, Auth, BodyMode, CollectionTree, RequestSpec, TreeItem},
};
use endpilot_postman_compat::{Imported, export_collection, export_environment, import};

fn collection(text: &str) -> CollectionTree {
    match import(text).unwrap() {
        Imported::Collection(c) => c,
        other => panic!("expected a collection, got {other:?}"),
    }
}

fn find<'a>(items: &'a [TreeItem], name: &str) -> Option<&'a RequestSpec> {
    items.iter().find_map(|i| match i {
        TreeItem::Request { name: n, request } if n == name => Some(request),
        TreeItem::Folder { items, .. } => find(items, name),
        _ => None,
    })
}

fn roundtrip(tree: &CollectionTree) -> CollectionTree {
    let exported = export_collection(tree);
    assert_eq!(
        exported["info"]["schema"],
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
    );
    collection(&serde_json::to_string_pretty(&exported).unwrap())
}

#[test]
fn v21_fixture_imports_every_supported_field() {
    let tree = collection(include_str!("fixtures/v21.postman_collection.json"));
    assert_eq!(tree.name, "Tienda API");
    assert_eq!(tree.variables.len(), 3);
    assert_eq!(tree.variables[1].value, "20");
    assert!(!tree.variables[2].enabled);

    let list = find(&tree.items, "Listar productos").unwrap();
    assert_eq!(list.params.len(), 3);
    assert!(!list.params[2].enabled);
    assert!(!list.headers[1].enabled);
    assert_eq!(
        list.auth,
        Auth::Inherit,
        "inheritance is kept, not flattened"
    );
    assert_eq!(
        tree.settings.auth,
        Auth::Bearer {
            token: "{{token}}".into()
        }
    );

    let create = find(&tree.items, "Crear producto").unwrap();
    assert_eq!(create.body_mode, BodyMode::Raw);
    assert_eq!(create.raw.language, RawLanguage::Json);

    let upload = find(&tree.items, "Subir imagen").unwrap();
    assert_eq!(upload.auth, Auth::Inherit, "inherits its folder's noauth");
    assert_eq!(upload.formdata[0].kind, FormFieldKind::File);
    assert_eq!(
        upload.formdata[0].value, "",
        "imported file paths are dropped"
    );
    assert!(!upload.formdata[2].enabled);

    let login = find(&tree.items, "Login").unwrap();
    assert_eq!(login.body_mode, BodyMode::Urlencoded);
    assert_eq!(login.urlencoded[1].value, "{{password}}");
    assert!(
        login
            .scripts
            .post_response
            .ends_with("pm.environment.set(\"token\", body.token);")
    );

    let status = find(&tree.items, "Estado (API key en query)").unwrap();
    assert!(
        matches!(&status.auth, Auth::Apikey { location: ApiKeyLocation::Query, key, .. } if key == "api_key")
    );

    let basic = find(&tree.items, "Basic").unwrap();
    assert_eq!(basic.method, "DELETE");
    assert_eq!(basic.raw.language, RawLanguage::Xml);
}

#[test]
fn v21_roundtrip_is_lossless() {
    let tree = collection(include_str!("fixtures/v21.postman_collection.json"));
    let again = roundtrip(&tree);
    assert_eq!(again, tree);
    assert_eq!(roundtrip(&again), tree);
}

#[test]
fn v20_fixture_imports_and_roundtrips() {
    let tree = collection(include_str!("fixtures/v20.postman_collection.json"));
    let view = find(&tree.items, "Ver usuario").unwrap();
    assert_eq!(view.method, "GET");
    assert_eq!(view.params[0].key, "expand");
    assert_eq!(view.auth, Auth::Inherit);
    let endpilot_core::model::TreeItem::Folder { settings, .. } = &tree.items[0] else {
        panic!("folder expected")
    };
    assert_eq!(
        settings.auth,
        Auth::Basic {
            username: "admin".into(),
            password: "{{pw}}".into()
        }
    );

    let update = find(&tree.items, "Actualizar").unwrap();
    assert_eq!(update.headers.len(), 2);
    assert_eq!(
        update.raw.language,
        RawLanguage::Json,
        "guessed from Content-Type"
    );

    assert_eq!(
        find(&tree.items, "Token").unwrap().auth,
        Auth::Bearer {
            token: "t0k".into()
        }
    );
    assert_eq!(roundtrip(&tree), tree);
}

#[test]
fn openapi_fixture_becomes_a_collection() {
    let tree = collection(include_str!("fixtures/petstore.openapi.yaml"));
    assert_eq!(tree.name, "Petstore");
    assert_eq!(tree.variables[0].value, "https://api.petstore.test/v1");
    let names: Vec<_> = tree
        .items
        .iter()
        .map(|i| match i {
            TreeItem::Folder { name, .. } | TreeItem::Request { name, .. } => name.as_str(),
        })
        .collect();
    assert_eq!(names, ["pets", "photos", "GET /health"]);

    let list = find(&tree.items, "Listar mascotas").unwrap();
    assert_eq!(list.url, "{{baseUrl}}/pets?limit=10");
    assert!(list.params[0].enabled && !list.params[1].enabled);
    assert_eq!(list.headers[0].key, "X-Trace-Id");
    assert_eq!(list.headers[0].value, "abc-123");
    assert_eq!(
        list.auth,
        Auth::Bearer {
            token: "{{bearerToken}}".into()
        }
    );

    let create = find(&tree.items, "createPet").unwrap();
    let body: serde_json::Value = serde_json::from_str(&create.raw.content).unwrap();
    assert_eq!(body["name"], "Firulais");
    assert_eq!(body["born"], "2024-01-01");
    assert_eq!(body["owner"]["email"], "user@example.com");

    let delete = find(&tree.items, "DELETE /pets/{petId}").unwrap();
    assert_eq!(delete.url, "{{baseUrl}}/pets/{{petId}}");
    assert_eq!(delete.auth, Auth::None);

    let photo = find(&tree.items, "POST /pets/{petId}/photo").unwrap();
    assert_eq!(photo.body_mode, BodyMode::Formdata);
    assert_eq!(photo.formdata[0].kind, FormFieldKind::File);
    assert_eq!(photo.formdata[1].value, "Hola");
    assert!(matches!(&photo.auth, Auth::Apikey { key, .. } if key == "X-API-Key"));

    // OpenAPI imports also survive a Postman round trip.
    assert_eq!(roundtrip(&tree), tree);
}

#[test]
fn environment_roundtrip() {
    let vars = vec![
        KeyValue {
            key: "a".into(),
            value: "1".into(),
            enabled: true,
        },
        KeyValue {
            key: "b".into(),
            value: "".into(),
            enabled: false,
        },
    ];
    let text = export_environment("Prod", &vars).to_string();
    assert_eq!(
        import(&text).unwrap(),
        Imported::Environment {
            name: "Prod".into(),
            variables: vars
        }
    );
}

#[test]
fn swagger2_is_rejected_with_a_clear_message() {
    let err = import("swagger: '2.0'\ninfo: { title: x }\npaths: {}").unwrap_err();
    assert!(err.contains("Swagger 2.0"));
}
