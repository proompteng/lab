package ai.proompteng.graf.routes

import ai.proompteng.graf.model.*
import ai.proompteng.graf.services.GraphService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Route.graphRoutes(service: GraphService) {
    post("/entities") {
        val payload = call.receive<EntityBatchRequest>()
        val response = service.upsertEntities(payload)
        call.respond(HttpStatusCode.OK, response)
    }

    post("/relationships") {
        val payload = call.receive<RelationshipBatchRequest>()
        val response = service.upsertRelationships(payload)
        call.respond(HttpStatusCode.OK, response)
    }

    patch("/entities/{id}") {
        val id = call.parameters["id"] ?: throw IllegalArgumentException("entity id missing")
        val payload = call.receive<EntityPatchRequest>()
        val response = service.patchEntity(id, payload)
        call.respond(HttpStatusCode.OK, response)
    }

    patch("/relationships/{id}") {
        val id = call.parameters["id"] ?: throw IllegalArgumentException("relationship id missing")
        val payload = call.receive<RelationshipPatchRequest>()
        val response = service.patchRelationship(id, payload)
        call.respond(HttpStatusCode.OK, response)
    }

    delete("/entities/{id}") {
        val id = call.parameters["id"] ?: throw IllegalArgumentException("entity id missing")
        val payload = call.receive<DeleteRequest>()
        val response = service.deleteEntity(id, payload)
        call.respond(HttpStatusCode.OK, response)
    }

    delete("/relationships/{id}") {
        val id = call.parameters["id"] ?: throw IllegalArgumentException("relationship id missing")
        val payload = call.receive<DeleteRequest>()
        val response = service.deleteRelationship(id, payload)
        call.respond(HttpStatusCode.OK, response)
    }

    post("/complement") {
        val payload = call.receive<ComplementRequest>()
        val response = service.complement(payload)
        call.respond(HttpStatusCode.OK, response)
    }

    post("/clean") {
        val payload = call.receive<CleanRequest>()
        val response = service.clean(payload)
        call.respond(HttpStatusCode.OK, response)
    }
}
