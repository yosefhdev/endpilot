//! Tipos compartidos entre la app de escritorio y el servidor.

pub mod http;
pub mod model;

use serde::{Deserialize, Serialize};

/// Versión del producto, común a cliente y servidor.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Respuesta de `GET /health` del servidor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    pub status: String,
    pub version: String,
}

impl Health {
    pub fn ok() -> Self {
        Self {
            status: "ok".into(),
            version: VERSION.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_roundtrips_as_json() {
        let json = serde_json::to_string(&Health::ok()).unwrap();
        assert_eq!(serde_json::from_str::<Health>(&json).unwrap(), Health::ok());
    }
}
