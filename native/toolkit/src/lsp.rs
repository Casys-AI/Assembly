//! Serveur LSP push natif (`sysmlv2_lsp::PushServer`) derrière N-API.
//!
//! Mêmes messages JSON-RPC que le `LspServer` amont : un message
//! client→serveur en texte, les messages serveur→client produits en
//! retour — y compris l'encodage de positions UTF-16 négocié à
//! `initialize` et les `textDocument/semanticTokens/full` consommés
//! par `toolkit-source-tokens.ts`. Même discipline de vie que les
//! sessions : `close()` déterministe et idempotent, panic attrapée
//! (`NATIVE_PANIC`) puis objet empoisonné (`LSP_POISONED`).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use sysmlv2_lsp::PushServer;

use crate::dto::SourceText;
use crate::{
    failure, panic_detail, validate_sources, ToolkitLibrary, LSP_SERVERS_ALIVE,
    LSP_SERVERS_CREATED, LSP_SERVERS_DISPOSED, NEXT_LSP_ID,
};

/// Serveur de langage SysML/KerML (`sysmlv2-lsp`, transport push).
///
/// Le constructeur est le serveur syntaxe seule (sans bibliothèque) —
/// celui que la tokenisation des sources utilise. Les variantes avec
/// bibliothèque voient en plus navigation et complétions. Toute
/// opération est synchrone.
#[napi]
pub struct NativeLspServer {
    id: String,
    server: Option<PushServer>,
    poisoned: bool,
    counted: bool,
}

impl NativeLspServer {
    fn register(server: PushServer) -> Self {
        let id = format!("tk-lsp-{}", NEXT_LSP_ID.fetch_add(1, Ordering::SeqCst));
        LSP_SERVERS_ALIVE.fetch_add(1, Ordering::SeqCst);
        LSP_SERVERS_CREATED.fetch_add(1, Ordering::SeqCst);
        NativeLspServer {
            id,
            server: Some(server),
            poisoned: false,
            counted: true,
        }
    }

    fn ensure_open(&self) -> Result<()> {
        if self.poisoned {
            return Err(failure(
                "LSP_POISONED",
                format!(
                    "LSP server {} was abandoned after a native panic; recreate it",
                    self.id
                ),
            ));
        }
        if self.server.is_none() {
            return Err(failure(
                "LSP_CLOSED",
                format!("LSP server {} is closed", self.id),
            ));
        }
        Ok(())
    }

    fn release_count(&mut self) {
        if self.counted {
            self.counted = false;
            LSP_SERVERS_ALIVE.fetch_sub(1, Ordering::SeqCst);
            LSP_SERVERS_DISPOSED.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Exécute une opération sur le serveur ouvert. Une panic
    /// empoisonne le serveur : l'état natif est détruit plutôt que
    /// réutilisé à moitié muté.
    fn run<T>(&mut self, operation: impl FnOnce(&mut PushServer) -> Result<T>) -> Result<T> {
        self.ensure_open()?;
        let outcome = {
            let server = self.server.as_mut().expect("server checked open");
            catch_unwind(AssertUnwindSafe(|| operation(server)))
        };
        match outcome {
            Ok(result) => result,
            Err(payload) => {
                self.server = None;
                self.poisoned = true;
                self.release_count();
                Err(failure(
                    "NATIVE_PANIC",
                    format!(
                        "panic caught at N-API boundary: {}; LSP server {} abandoned",
                        panic_detail(&*payload),
                        self.id
                    ),
                ))
            }
        }
    }
}

#[napi]
impl NativeLspServer {
    /// Le serveur syntaxe seule (pas de bibliothèque standard).
    /// Infaillible, comme le constructeur amont.
    #[napi(constructor)]
    pub fn new() -> Self {
        NativeLspServer::register(PushServer::new())
    }

    /// Un serveur dont navigation et complétions voient la
    /// bibliothèque standard : sources mémoire, avec le snapshot de
    /// résolution scellé optionnel enregistré contre ces unités.
    #[napi(factory)]
    pub fn with_library_sources(
        sources: Vec<SourceText>,
        snapshot: Option<Uint8Array>,
    ) -> Result<Self> {
        let units = validate_sources(sources)?;
        let snapshot = snapshot.map(|bytes| {
            let slice: &[u8] = bytes.as_ref();
            slice.to_vec()
        });
        Ok(NativeLspServer::register(PushServer::with_library_sources(
            units, snapshot,
        )))
    }

    /// Un serveur dont navigation et complétions voient une
    /// bibliothèque préparée partagée. Le serveur retient sa propre
    /// référence ; le handle peut être fermé ensuite. Une
    /// bibliothèque décodée avec `keepHostParts: true` fournit sa
    /// table de symboles au serveur.
    #[napi(factory)]
    pub fn with_prepared_library(library: &ToolkitLibrary) -> Result<Self> {
        let library = library.cloned_library()?;
        Ok(NativeLspServer::register(PushServer::with_library(library)))
    }

    #[napi(getter)]
    pub fn server_id(&self) -> String {
        self.id.clone()
    }

    #[napi(getter)]
    pub fn is_closed(&self) -> bool {
        self.server.is_none()
    }

    /// Traite un message JSON-RPC (texte) ; retourne les messages
    /// serveur→client produits (textes), exactement comme le
    /// `handle` amont.
    #[napi]
    pub fn handle(&mut self, message: String) -> Result<Vec<String>> {
        self.run(|server| {
            server
                .handle(&message)
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })
    }

    /// Ensemence (ou remplace) l'espace de travail de navigation :
    /// chaque `name` est l'URI sous lequel le client ouvre le
    /// document. Retourne les demandes de refresh produites, à
    /// relayer comme la sortie de `handle`.
    #[napi]
    pub fn set_workspace(&mut self, sources: Vec<SourceText>) -> Result<Vec<String>> {
        let units = validate_sources(sources)?;
        self.run(|server| {
            server.set_workspace_sources(units);
            server
                .take_outbound()
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })
    }

    /// Forme JSON `[{name, text}]` de `setWorkspace`.
    #[napi]
    pub fn set_workspace_json(&mut self, sources_json: String) -> Result<Vec<String>> {
        let units = crate::json_api::parse_sources_json(&sources_json)
            .map_err(|message| failure("INVALID_INPUT", message))?;
        self.run(|server| {
            server.set_workspace_sources(units);
            server
                .take_outbound()
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })
    }

    /// Abandonne les sessions de navigation en cache après une
    /// reconfiguration moteur côté hôte ; retourne les demandes de
    /// refresh à relayer.
    #[napi]
    pub fn invalidate_sessions(&mut self) -> Result<Vec<String>> {
        self.run(|server| {
            server.invalidate_sessions();
            server
                .take_outbound()
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })
    }

    /// Supprime (défaut) ou non les hints de valeur qui répètent
    /// l'expression déclarée ; retourne les demandes de refresh.
    #[napi]
    pub fn set_hide_redundant_value_hints(&mut self, on: bool) -> Result<Vec<String>> {
        self.run(|server| {
            server.set_hide_redundant_value_hints(on);
            server
                .take_outbound()
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })
    }

    /// Format d'écriture des rationnels sans expansion décimale
    /// finie (`exact`, `approx`, `overline`, `parens`, `unicode`,
    /// réglages `digits=`/`period=`/…) ; lève `INVALID_INPUT` sur
    /// une spec illisible. Retourne les demandes de refresh.
    #[napi]
    pub fn set_number_format(&mut self, spec: String) -> Result<Vec<String>> {
        let format = sysmlv2_model::numfmt::NumberFormat::parse(&spec)
            .map_err(|message| failure("INVALID_INPUT", message))?;
        self.run(|server| {
            server.set_number_format(format);
            server
                .take_outbound()
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })
    }

    /// Accepter une complétion d'unité dans un crochet de quantité
    /// non typé déclare aussi le type déterminé (défaut : oui).
    #[napi]
    pub fn set_infer_unit_types(&mut self, on: bool) -> Result<()> {
        self.run(|server| {
            server.set_infer_unit_types(on);
            Ok(())
        })
    }

    /// Libère déterministement l'état Rust. Idempotent ; tout appel
    /// ultérieur (hors getters d'identité) échoue en `LSP_CLOSED`.
    #[napi]
    pub fn close(&mut self) {
        if self.server.take().is_some() {
            self.release_count();
        }
    }

    /// Alias de `close()`.
    #[napi]
    pub fn dispose(&mut self) {
        self.close();
    }
}

impl Drop for NativeLspServer {
    fn drop(&mut self) {
        self.server = None;
        self.release_count();
    }
}
