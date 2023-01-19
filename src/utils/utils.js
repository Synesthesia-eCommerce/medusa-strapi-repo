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

function getFieldsWithoutRelationsAndMedia(attributes) {
  const keys = Object.keys(attributes);
  const fields = keys.filter(
    (k) => !(attributes[k].relation || attributes[k].type == "media")
  );
  return fields;
}

function getUniqueKeys(attributes) {
  const keys = Object.keys(attributes);
  const uniqueAttributes = keys.filter(
    (k) =>
      !attributes[k].relation &&
      (attributes[k].unique == true || attributes[k].type == "uid")
  );
  return uniqueAttributes;
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
  const fields = getFieldsWithoutRelationsAndMedia(model[apiName].attributes);
  strapi.log.debug(`requested ${uid} ${medusa_id}`);
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
async function uploadFile(strapi, uid, files, processedData, fieldName) {
  const service = strapi.service("plugin::upload.content-api");
  const id = processedData.id;
  const apiName = uid.split(".")[1];
  const model = strapi.api[apiName].contentTypes;
  const field = fieldName;

  try {
    const uploadedFile = await service.uploadToEntity(
      {
        id,
        model,
        field,
      },
      files
    );
    return uploadedFile;
  } catch (e) {
    strapi.log.error("file upload failed");
    throw e;
  }
}

async function controllerCreate(ctx, strapi, uid) {
  delete ctx.request.body?.data?.id;
  let processedData;
  try {
    const data = _.cloneDeep(ctx.request.body.data ?? ctx.request.body);
    let files;
    if (ctx.request.files) {
      files = _.cloneDeep(ctx.request.files);
      delete data.files;
    }
    processedData = await attachOrCreateStrapiIdFromMedusaId(uid, strapi, data);
    if (processedData && files) {
      await uploadFile(strapi, uid, files, processedData);
    }
    ctx.body = processedData;
    strapi.log.info(`created element ${uid} ${JSON.stringify(processedData)}`);
  } catch (e) {
    handleError(strapi, e);
    return ctx.internalServerError(ctx);
  }

  return ctx.body;
}

async function getStrapiIdFromMedusaId(uid, strapi, medusa_id) {
  return (
    await getStrapiDataByMedusaId(uid, strapi, medusa_id, ["medusa_id", "id"])
  )?.id;
}

function findContentUid(name, strapi) {
  let objectUid;
  const contentTypes = Object.keys(strapi.contentTypes);
  for (const contentType of contentTypes) {
    const value = strapi.contentTypes[contentType];
    if (
      value.collectionName == name ||
      value.info.singularName == name ||
      value.info.pluralName == name
    ) {
      objectUid = `api::${value.info.singularName}.${value.info.singularName}`;
      return objectUid;
    }
  }
  return objectUid;
}
// eslint-disable-next-line valid-jsdoc
/**
 * retrieves the strapi id of the received medusa data and attaches it to the data.
 * @param {*} uid - the application uid
 * @param {*} strapi - the strapi Object
 * @param {*} dataReceived the medusa data
 * @returns
 */
async function attachOrCreateStrapiIdFromMedusaId(uid, strapi, dataReceived) {
  if (!dataReceived) {
    return;
  }
  const keys = Object.keys(dataReceived);
  if (keys.includes("medusa_id")) {
    for (const key of keys) {
      if (Array.isArray(dataReceived[key])) {
        for (const element of dataReceived[key]) {
          const objectUid = findContentUid(key, strapi);
          if (objectUid) {
            await attachOrCreateStrapiIdFromMedusaId(
              objectUid,
              strapi,
              element
            );
          }
        }
      } else if (dataReceived[key] instanceof Object) {
        const objectUid = findContentUid(key, strapi);
        await attachOrCreateStrapiIdFromMedusaId(
          objectUid,
          strapi,
          dataReceived[key]
        );
      }
    }
    try {
      let strapiId;
      if (keys.includes("medusa_id")) {
        const key = "medusa_id";

        strapiId = await getStrapiIdFromMedusaId(
          uid,
          strapi,
          dataReceived[key]
        );
      } else {
        strapiId = await getStrapiEntityByUniqueField(
          uid,
          strapi,
          dataReceived
        );
      }
      try {
        if (!strapiId) {
          strapi.log.debug(`${uid} creating, ${JSON.stringify(dataReceived)}`);
          const newEntity = await strapi.entityService.create(uid, {
            data: dataReceived,
          });
          dataReceived["id"] = newEntity.id;
        } else {
          dataReceived["id"] = strapiId;
        }
      } catch (e) {
        strapi.log.error(`unable to create  ${e.message} ${uid}`);
        throw e;
      }
    } catch (e) {
      strapi.log.error(`no such service  ${e.message} ${uid}`);
      throw e;
    }
    return dataReceived;
  }

  return dataReceived;
}

async function getStrapiEntityByUniqueField(uid, strapi, dataReceived) {
  try {
    const apiName = uid.split(".")[1];
    const model = strapi.api[apiName].contentTypes;
    const uniqueFields = getUniqueKeys(model[apiName].attributes);

    for (const field of uniqueFields) {
      const filters = {};
      filters[field] = dataReceived[field];
      try {
        const entity = await strapi.entityService.findMany(uid, {
          filters,
        });
        if (entity.length > 0) {
          return entity[0];
        }
      } catch (e) {
        strapi.log.error(`unique entity search error ${uid} ${e.message}`);
      }
    }
  } catch (e) {
    strapi.log.error(`service not found ${uid} ${e.message}`);
  }
}

async function createNestedEntity(uid, strapi, dataReceived) {
  if (!dataReceived) {
    return;
  }
  const keys = Object.keys(dataReceived);
  if (keys.includes("medusa_id")) {
    for (const key of keys) {
      if (Array.isArray(dataReceived[key])) {
        for (const element of dataReceived[key]) {
          const objectUid = findContentUid(key, strapi);
          if (objectUid) {
            createNestedEntity(objectUid, strapi, element);
          }
        }
      } else if (dataReceived[key] instanceof Object) {
        const objectUid = findContentUid(key, strapi);
        createNestedEntity(objectUid, strapi, dataReceived[key]);
      } else {
        try {
          const objectUid = findContentUid(key, strapi);
          const service = strapi.service(objectUid);
          let existingEntity;
          if (keys.includes("medusa_id")) {
            existingEntity = await getStrapiIdFromMedusaId(
              uid,
              strapi,
              dataReceived["medusa_id"]
            );
            return existingEntity;
          } else {
            existingEntity = await getStrapiEntityByUniqueField(
              uid,
              strapi,
              dataReceived[key]
            );
            if (!existingEntity) {
              const newEntity = service.create({ data: dataReceived[key] });
              return newEntity;
            }
            return existingEntity;
          }
        } catch (e) {
          strapi.log.error(`no such servce ${uid}`);
        }
      }
      return dataReceived;
    }
  }

  return dataReceived;
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
  const entities = await strapi.entityService.findMany(uid, {
    fields,
    filters,
  });
  let entity = entities?.length ? entities[0] : undefined;
  if (!entity) {
    const allEntities = await strapi.entityService.findMany(uid);
    entity = allEntities.filter((e) => {
      return e?.medusa_id == medusa_id;
    })[0];
    if (entity) {
      entity = await strapi.entityService.findOne(uid, entity.id, {
        fields,
      });
    }
    /* const translatedEntity = await translateStrapiIdsToMedusaIds(
      uid,
      strapi,
      entity
    );*/
  }
  return entity;
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
      return await controllerfindOne(ctx, strapi, uid);
    },
    async delete(ctx) {
      return await controllerDelete(ctx, strapi, uid);
    },
    async create(ctx) {
      return await controllerCreate(ctx, strapi, uid);
    },

    async update(ctx) {
      return await controllerUpdate(ctx, strapi, uid);
    },
  });
}

module.exports = {
  hasSuperUser,
  createSuperUser,
  handleError,
  getFields,
  controllerfindOne,
  getStrapiDataByMedusaId,
  createMedusaDefaultController,
  createNestedEntity,
  translateStrapiIdsToMedusaIds,
};
