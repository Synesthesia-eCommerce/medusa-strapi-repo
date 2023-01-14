const { createCoreController } = require("@strapi/strapi").factories;
const _ = require("lodash");
async function hasSuperUser(strapi) {
  strapi.log.debug(`Checking if Superuser exists`);
  const superAdminRole = await strapi.service("admin::user").exists();
  return superAdminRole ? true : false;
}

async function createSuperUser(strapi) {
  strapi.log.warn("No SuperUser found. Creating Superuser now....");

  try {
    const params = {
      username: process.env.SUPERUSER_USERNAME || "SuperUser",
      password: process.env.SUPERUSER_PASSWORD || "MedusaStrapi1",
      firstname: process.env.SUPERUSER_FIRSTNAME || "Medusa",
      lastname: process.env.SUPERUSER_LASTNAME || "Commerce",
      email: process.env.SUPERUSER_EMAIL || "support@medusa-commerce.com",
      blocked: false,
      isActive: true,
    };

    const hasAdmin = await strapi.service("admin::user").exists();

    if (hasAdmin) {
      return;
    }

    const superAdminRole = await strapi.service("admin::role").getSuperAdmin();

    if (!superAdminRole) {
      strapi.log.info("Superuser account exists");
      return;
    }

    await strapi.service("admin::user").create({
      email: params.email,
      firstname: params.firstname,
      username: params.username,
      lastname: params.lastname,
      password: params.password,
      registrationToken: null,
      isActive: true,
      roles: superAdminRole ? [superAdminRole.id] : [],
    });

    strapi.log.info("Superuser account created");
  } catch (error) {
    console.error(error);
  }
}

function getFields(filename, dirName) {
  const fileNameParts = filename.split("/");
  const fileNameWithExtension = fileNameParts[fileNameParts.length - 1];
  const folderName = fileNameWithExtension.split(".")[0];
  const schema = require(`${dirName}/../content-types/${folderName}/schema.json`);
  return getRequiredKeys(schema.attributes);
}

function getRequiredKeys(attributes) {
  const keys = Object.keys(attributes);
  const requiredAttributes =
    process.env.NODE_ENV == "test"
      ? ["id", "medusa_id"]
      : keys.filter((k) => !attributes[k].relation);
  return requiredAttributes;
}

function handleError(strapi, e) {
  const details = JSON.stringify(e.details);
  strapi.log.error(`Error Occurred ${e.name} ${e.message}`);
  strapi.log.error(`Error Details ${details}`);
  strapi.log.error(`stack trace ${e.stack}`);
}

async function controllerfindOne(ctx, strapi, uid) {
  const { id: medusa_id } = ctx.params;
  const apiName = uid.split(".")[1];
  const model = strapi.api[apiName].contentTypes;
  const fields = getRequiredKeys(model[apiName].attributes);

  try {
    const entity = await getStrapiDataByMedusaId(
      uid,
      strapi,
      medusa_id,
      fields
    );

    if (entity && entity.id) {
      return (ctx.body = { data: entity });
    }
    return ctx.notFound(ctx);
  } catch (e) {
    handleError(strapi, e);
    return ctx.internalServerError(ctx);
  }
  // const entity = await strapi.service("api::entity-service.entity-service").findOne({ region_id: medusaId });
}

async function controllerCreate(ctx, strapi, uid) {
  delete ctx.request.body?.data?.id;
  let processedData;
  try {
    const data = _.cloneDeep(ctx.request.body.data);
    processedData = await translateMedusaIdsToStrapiIds(uid, strapi, data);
  } catch (e) {
    handleError(strapi, e);
    return ctx.internalServerError(ctx);
  }
  try {
    ctx.body = await strapi.entityService.create(uid, {
      ...ctx.request.body,
      data: processedData,
    });
  } catch (e) {
    handleError(strapi, e);
    return ctx.internalServerError(ctx);
  }
  return ctx.body;
}

async function getStrapiIdFromMedusaId(uid, strapi, medusa_id) {
  return (
    await getStrapiDataByMedusaId(uid, strapi, medusa_id, ["id", "medusa_id"])
  )?.id;
}

async function translateMedusaIdsToStrapiIds(uid, strapi, dataRecieved) {
  if (!dataRecieved) {
    return;
  }
  const keys = Object.keys(dataRecieved);
  for (const key of keys) {
    if (dataRecieved[key] instanceof Array) {
      const objectUid = `api::${key}.${key}`;
      for (const element of dataRecieved[key]) {
        translateMedusaIdsToStrapiIds(objectUid, strapi, element);
      }
    } else if (dataRecieved[key] instanceof Object) {
      const objectUid = `api::${key}.${key}`;
      translateMedusaIdsToStrapiIds(objectUid, strapi, dataRecieved[key]);
    } else if (key == "medusa_id") {
      try {
        const service = strapi.service(uid);
        const strapiId = await getStrapiIdFromMedusaId(
          uid,
          strapi,
          dataRecieved[key]
        );
        if (strapiId) {
          dataRecieved["id"] = strapiId;
        }
      } catch (e) {
        strapi.log.error("no such service " + e.message);
      }
      return dataRecieved;
    }
  }
  return dataRecieved;
}

async function translateStrapiIdsToMedusaIds(uid, strapi, dataToSend) {
  if (!dataToSend) {
    return;
  }
  const keys = Object.keys(dataToSend);

  for (const key of keys) {
    if (dataToSend[key] instanceof Array) {
      for (const element of dataToSend[key]) {
        const objectUid = `api::${key}.${key}`;
        translateStrapiIdsToMedusaIds(objectUid, strapi, element);
      }
    } else if (dataToSend[key] instanceof Object) {
      const objectUid = `api::${key}.${key}`;
      translateStrapiIdsToMedusaIds(objectUid, strapi, dataToSend[key]);
    } else if (key == "id") {
      try {
        const entity = await strapi
          .service(uid)
          .findOne(dataToSend[key], uid, strapi);
        if (entity) {
          dataToSend["medusa_id"] = entity.medusa_id;
        }
      } catch (e) {
        strapi.log.error("error retrieving one " + e.message);
      }

      return dataToSend;
    }
  }
  return dataToSend;
}

async function getStrapiDataByMedusaId(uid, strapi, medusa_id, fields) {
  const filters = {
    medusa_id: medusa_id,
  };
  let entity = await strapi.entityService.findMany(uid, {
    fields,
    filters,
  })[0];
  if (!entity) {
    const allEntities = await strapi.entityService.findMany(uid, {
      fields,
    });
    entity = allEntities.filter((e) => {
      return e?.medusa_id == medusa_id;
    })[0];
    const translatedEntity = await translateStrapiIdsToMedusaIds(
      uid,
      strapi,
      entity
    );
    return translatedEntity;
  }
}

async function controllerDelete(ctx, strapi, uid) {
  const { id: medusa_id } = ctx.params;
  try {
    const entityId = await getStrapiIdFromMedusaId(uid, strapi, medusa_id);
    if (!entityId) {
      return ctx.notFound(ctx);
    }
    const result = await strapi.services[uid].delete(entityId);
    if (result) {
      return (ctx.body = { deletedData: result });
    }
  } catch (e) {
    handleError(strapi, e);
    return ctx.internalServerError(ctx);
  }
}

async function controllerUpdate(ctx, strapi, uid) {
  const { id: medusa_id } = ctx.params;
  delete ctx.request.body?.data?.id;
  try {
    const entityId = await getStrapiIdFromMedusaId(uid, strapi, medusa_id);

    if (entityId) {
      return (ctx.body = await strapi.services[uid].update(
        entityId,
        ctx.request.body
      ));
    } else {
      return ctx.notFound(ctx);
    }
  } catch (e) {
    handleError(strapi, e);
    return ctx.internalServerError(ctx);
  }
}

function createMedusaDefaultController(uid) {
  return createCoreController(uid, {
    async findOne(ctx) {
      return controllerfindOne(ctx, strapi, uid);
    },
    async delete(ctx) {
      return controllerDelete(ctx, strapi, uid);
    },
    async create(ctx) {
      return controllerCreate(ctx, strapi, uid);
    },

    async update(ctx) {
      return controllerUpdate(ctx, strapi, uid);
    },
  });
}

module.exports = {
  hasSuperUser,
  createSuperUser,
  handleError,
  getFields,
  controllerfindOne,
  createMedusaDefaultController,
};
