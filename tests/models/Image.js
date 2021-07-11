'use strict';

module.exports = (sequelize, DataTypes) => {

  const Image = sequelize.define('Image', {
      url: {
        type: DataTypes.STRING,
        allowNull: false
      }
  }, {
    paranoid: false,
    scopes: {
      scope(value) {
        return { where: { scopeId: value } };
      }
    }
  });

  Image.associate = function(models) {
    Image.belongsToMany(models.Product, {through: models.ProductMedia, as: 'MediaProduct', foreignKey: 'imageId'});
    Image.belongsToMany(models.Product, {through: models.ProductImage, foreignKey: 'imageId'});
  };

  return Image;

};
