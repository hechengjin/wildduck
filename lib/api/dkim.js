'use strict';

const Joi = require('../joi');
const MongoPaging = require('mongo-cursor-pagination-node6');
const ObjectID = require('mongodb').ObjectID;
const tools = require('../tools');
const fingerprint = require('key-fingerprint').fingerprint;
const pki = require('node-forge').pki;
const crypto = require('crypto');

module.exports = (db, server) => {
    /**
     * @api {get} /dkim List registered DKIM keys
     * @apiName GetDkim
     * @apiGroup DKIM
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} [query] Partial match of a Domain name
     * @apiParam {Number} [limit=20] How many records to return
     * @apiParam {Number} [page=1] Current page number. Informational only, page numbers start from 1
     * @apiParam {Number} [next] Cursor value for next page, retrieved from <code>nextCursor</code> response value
     * @apiParam {Number} [previous] Cursor value for previous page, retrieved from <code>previousCursor</code> response value
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {Number} total How many results were found
     * @apiSuccess {Number} page Current page number. Derived from <code>page</code> query argument
     * @apiSuccess {String} previousCursor Either a cursor string or false if there are not any previous results
     * @apiSuccess {String} nextCursor Either a cursor string or false if there are not any next results
     * @apiSuccess {Object[]} results Aliases listing
     * @apiSuccess {String} results.id ID of the DKIM
     * @apiSuccess {String} results.domain The domain this DKIM key applies to
     * @apiSuccess {String} results.selector DKIM selector
     * @apiSuccess {String} results.description Key description
     * @apiSuccess {String} results.fingerprint Key fingerprint (SHA1)
     * @apiSuccess {String} results.created Datestring
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/dkim
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "total": 1,
     *       "page": 1,
     *       "previousCursor": false,
     *       "nextCursor": false,
     *       "results": [
     *         {
     *           "id": "59ef21aef255ed1d9d790e81",
     *           "domain": "example.com",
     *           "selector": "oct17",
     *           "description": "Key for marketing emails",
     *           "fingerprint": "6a:aa:d7:ba:e4:99:b4:12:e0:f3:35:01:71:d4:f1:d6:b4:95:c4:f5",
     *           "created": "2017-10-24T11:19:10.911Z"
     *         }
     *       ]
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "Database error"
     *     }
     */
    server.get({ name: 'dkim', path: '/dkim' }, (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            query: Joi.string()
                .empty('')
                .trim()
                .max(255),
            limit: Joi.number()
                .default(20)
                .min(1)
                .max(250),
            next: Joi.string()
                .empty('')
                .mongoCursor()
                .max(1024),
            previous: Joi.string()
                .empty('')
                .mongoCursor()
                .max(1024),
            page: Joi.number().default(1)
        });

        const result = Joi.validate(req.query, schema, {
            abortEarly: false,
            convert: true,
            allowUnknown: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let query = result.value.query;
        let limit = result.value.limit;
        let page = result.value.page;
        let pageNext = result.value.next;
        let pagePrevious = result.value.previous;

        let filter = query
            ? {
                domain: {
                    $regex: query.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
                    $options: ''
                }
            }
            : {};

        db.users.collection('dkim').count(filter, (err, total) => {
            if (err) {
                res.json({
                    error: err.message
                });
                return next();
            }

            let opts = {
                limit,
                query: filter,
                paginatedField: 'domain',
                sortAscending: true
            };

            if (pageNext) {
                opts.next = pageNext;
            } else if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            MongoPaging.find(db.users.collection('dkim'), opts, (err, result) => {
                if (err) {
                    res.json({
                        error: err.message
                    });
                    return next();
                }

                if (!result.hasPrevious) {
                    page = 1;
                }

                let response = {
                    success: true,
                    query,
                    total,
                    page,
                    previousCursor: result.hasPrevious ? result.previous : false,
                    nextCursor: result.hasNext ? result.next : false,
                    results: (result.results || []).map(dkimData => ({
                        id: dkimData._id.toString(),
                        domain: dkimData.domain,
                        selector: dkimData.selector,
                        description: dkimData.description,
                        fingerprint: dkimData.fingerprint,
                        created: dkimData.created
                    }))
                };

                res.json(response);
                return next();
            });
        });
    });

    /**
     * @api {post} /dkim Create or update DKIM key for domain
     * @apiName PostDkim
     * @apiGroup DKIM
     * @apiDescription Add a new DKIM key for a Domain or update existing one. There can be single DKIM key
     * registered for each domain name.
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} domain Domain name this DKIM key applies to. Use <code>"\*"</code> as a special value that will be used for domains that do not have their own DKIM key set
     * @apiParam {String} selector Selector for the key
     * @apiParam {String} [description] Key description
     * @apiParam {String} privateKey Pem formatted DKIM private key
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the DKIM
     * @apiSuccess {String} domain The domain this DKIM key applies to
     * @apiSuccess {String} selector DKIM selector
     * @apiSuccess {String} description Key description
     * @apiSuccess {String} fingerprint Key fingerprint (SHA1)
     * @apiSuccess {String} publicKey Public key in DNS format (no prefix/suffix, single line)
     * @apiSuccess {Object} dnsTxt Value for DNS TXT entry
     * @apiSuccess {String} dnsTxt.name Is the domain name of TXT
     * @apiSuccess {String} dnsTxt.value Is the value of TXT
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPOST http://localhost:8080/dkim \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "domain": "example.com",
     *       "selector": "oct17",
     *       "description": "Key for marketing emails",
     *       "privateKey": "-----BEGIN RSA PRIVATE KEY-----..."
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e81",
     *       "domain": "example.com",
     *       "selector": "oct17",
     *       "description": "Key for marketing emails",
     *       "fingerprint": "6a:aa:d7:ba:e4:99:b4:12:e0:f3:35:01:71:d4:f1:d6:b4:95:c4:f5",
     *       "publicKey": "-----BEGIN PUBLIC KEY-----\r\nMIGfMA0...",
     *       "dnsTxt": {
     *         "name": "dec20._domainkey.example.com",
     *         "value": "v=DKIM1;t=s;p=MIGfMA0..."
     *       }
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.post('/dkim', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            domain: Joi.string()
                .max(255)
                //.hostname()
                .required(),
            selector: Joi.string()
                .max(255)
                //.hostname()
                .trim()
                .required(),
            privateKey: Joi.string()
                .empty('')
                .trim()
                .regex(/^-----BEGIN RSA PRIVATE KEY-----/, 'DKIM key format')
                .required(),
            description: Joi.string()
                .max(255)
                //.hostname()
                .trim()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let domain = tools.normalizeDomain(req.params.domain);
        let selector = req.params.selector;
        let description = req.params.description;

        let fp, publicKeyPem;
        try {
            fp = fingerprint(result.value.privateKey, 'sha256', true);
            let privateKey = pki.privateKeyFromPem(result.value.privateKey);
            let publicKey = pki.setRsaPublicKey(privateKey.n, privateKey.e);
            publicKeyPem = pki.publicKeyToPem(publicKey);
            if (!publicKeyPem) {
                throw new Error('Was not able to extract public key from private key');
            }

            let ciphered = crypto.publicEncrypt(publicKeyPem, Buffer.from('secretvalue'));
            let deciphered = crypto.privateDecrypt(result.value.privateKey, ciphered);
            if (deciphered.toString() !== 'secretvalue') {
                throw new Error('Was not able to use key for encryption');
            }
        } catch (E) {
            res.json({
                error: 'Invalid or incompatible private key',
                code: 'InputValidationError'
            });
            return next();
        }

        let dkimData = {
            domain,
            selector,
            privateKey: result.value.privateKey,
            publicKey: publicKeyPem,
            fingerprint: fp,
            created: new Date(),
            latest: true
        };

        if (description) {
            dkimData.description = description;
        }

        db.users.collection('dkim').findOneAndReplace(
            {
                domain
            },
            dkimData,
            {
                upsert: true,
                returnOriginal: false
            },
            (err, r) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }

                if (!r.value) {
                    res.json({
                        error: 'Failed to insert DKIM key',
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }

                res.json({
                    success: true,
                    id: r.value._id,
                    domain: dkimData.domain,
                    selector: dkimData.selector,
                    description: dkimData.description,
                    fingerprint: dkimData.fingerprint,
                    publicKey: dkimData.publicKey,
                    dnsTxt: {
                        name: dkimData.selector + '._domainkey.' + dkimData.domain,
                        value: 'v=DKIM1;t=s;p=' + dkimData.publicKey.replace(/^-.*-$/gm, '').replace(/\s/g, '')
                    }
                });
                return next();
            }
        );
    });

    /**
     * @api {get} /dkim/:dkim Request DKIM information
     * @apiName GetDkimKey
     * @apiGroup DKIM
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} dkim ID of the DKIM
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the DKIM
     * @apiSuccess {String} domain The domain this DKIM key applies to
     * @apiSuccess {String} selector DKIM selector
     * @apiSuccess {String} description Key description
     * @apiSuccess {String} fingerprint Key fingerprint (SHA1)
     * @apiSuccess {String} publicKey Public key in DNS format (no prefix/suffix, single line)
     * @apiSuccess {Object} dnsTxt Value for DNS TXT entry
     * @apiSuccess {String} dnsTxt.name Is the domain name of TXT
     * @apiSuccess {String} dnsTxt.value Is the value of TXT
     * @apiSuccess {String} created Datestring
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/dkim/59ef21aef255ed1d9d790e7a
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e7a",
     *       "domain": "example.com",
     *       "selector": "oct17",
     *       "description": "Key for marketing emails",
     *       "fingerprint": "6a:aa:d7:ba:e4:99:b4:12:e0:f3:35:01:71:d4:f1:d6:b4:95:c4:f5",
     *       "publicKey": "-----BEGIN PUBLIC KEY-----\r\nMIGfMA0...",
     *       "dnsTxt": {
     *         "name": "dec20._domainkey.example.com",
     *         "value": "v=DKIM1;t=s;p=MIGfMA0..."
     *       }
     *       "created": "2017-10-24T11:19:10.911Z"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This Alias does not exist"
     *     }
     */
    server.get('/dkim/:dkim', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            dkim: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let dkim = new ObjectID(result.value.dkim);

        db.users.collection('dkim').findOne(
            {
                _id: dkim
            },
            (err, dkimData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }
                if (!dkimData) {
                    res.status(404);
                    res.json({
                        error: 'Invalid or unknown DKIM key'
                    });
                    return next();
                }

                res.json({
                    success: true,
                    id: dkimData._id,
                    domain: dkimData.domain,
                    selector: dkimData.selector,
                    description: dkimData.description,
                    fingerprint: dkimData.fingerprint,
                    publicKey: dkimData.publicKey,
                    dnsTxt: {
                        name: dkimData.selector + '._domainkey.' + dkimData.domain,
                        value: 'v=DKIM1;t=s;p=' + dkimData.publicKey.replace(/^-.*-$/gm, '').replace(/\s/g, '')
                    },
                    created: dkimData.created
                });

                return next();
            }
        );
    });

    /**
     * @api {delete} /dkim/:dkim Delete a DKIM key
     * @apiName DeleteDkim
     * @apiGroup DKIM
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} dkim ID of the DKIM
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XDELETE http://localhost:8080/dkim/59ef21aef255ed1d9d790e81
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "Database error"
     *     }
     */
    server.del('/dkim/:dkim', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            dkim: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let dkim = new ObjectID(result.value.dkim);

        // delete address from email address registry
        db.users.collection('dkim').deleteOne(
            {
                _id: dkim
            },
            (err, r) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }

                if (!r.deletedCount) {
                    res.status(404);
                    res.json({
                        error: 'Invalid or unknown DKIM key'
                    });
                    return next();
                }

                res.json({
                    success: !!r.deletedCount
                });
                return next();
            }
        );
    });
};
