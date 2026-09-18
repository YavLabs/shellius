import { Prisma } from '@prisma/client';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';

const errorHandler = (err, req, res, _next) => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let code;
  let details;

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    code = err.code;
    details = err.details;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        statusCode = 409;
        message = 'Resource already exists';
        break;
      case 'P2025':
        statusCode = 404;
        message = 'Resource not found';
        break;
      default:
        statusCode = 400;
        message = 'Database request error';
    }
  }

  logger.error(`${statusCode} - ${message}`, {
    path: req.path,
    method: req.method,
    stack: err.stack,
  });

  const response = {
    success: false,
    error: {
      code: code || statusCode,
      message,
      ...(details ? { details } : {}),
    },
  };

  if (config.nodeEnv === 'development') {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

export default errorHandler;
