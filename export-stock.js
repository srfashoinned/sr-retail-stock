const sql = require("mssql");
const fs = require("fs");
const config = require("./config.json");

async function exportStock() {
    let pool;

    try {
        console.log("========================================");
        console.log("SR FASHION - RETAIL DADDY STOCK EXPORT");
        console.log("========================================");
        console.log("Connecting to Retail Daddy SQL Server...");

        pool = await sql.connect(config);

        console.log("DATABASE CONNECTED SUCCESSFULLY");
        console.log("Exporting products, prices and live stock...");
        console.log("");

        const result = await pool.request().query(`
            SELECT
                P.PID AS ProductID,

                LTRIM(RTRIM(ISNULL(P.ProductCode, ''))) AS ProductCode,
                LTRIM(RTRIM(ISNULL(P.ProductName, ''))) AS ProductName,

                LTRIM(RTRIM(ISNULL(SC.Category, ''))) AS Category,
                LTRIM(RTRIM(ISNULL(SC.SubCategoryName, ''))) AS SubCategory,

                LTRIM(RTRIM(
                    CASE
                        WHEN ISNULL(P.PartNo, '') <> ''
                            THEN P.PartNo
                        WHEN ISNULL(SC.SubCategoryName, '') <> ''
                            THEN SC.SubCategoryName
                        ELSE ISNULL(SC.Category, '')
                    END
                )) AS PartGroup,

                LTRIM(RTRIM(ISNULL(P.HSNCode, ''))) AS HSNCode,
                LTRIM(RTRIM(ISNULL(P.Barcode, ''))) AS Barcode,

                ISNULL(P.MRP, 0) AS MRP,
                ISNULL(P.SellingPrice, 0) AS SalePrice,

                /* Wholesale Price */
                ISNULL(
                    (
                        SELECT TOP 1 O.WSalePrice
                        FROM dbo.Product_OpeningStock O
                        WHERE O.ProductID = P.PID
                        ORDER BY O.ID DESC
                    ),
                    0
                ) AS WholesalePrice,

                /* Purchase Price */
                ISNULL(
                    (
                        SELECT TOP 1 O.PPrice
                        FROM dbo.Product_OpeningStock O
                        WHERE O.ProductID = P.PID
                        ORDER BY O.ID DESC
                    ),
                    ISNULL(P.CostPrice, 0)
                ) AS PurchasePrice,

                /* Product.OpeningStock */
                CAST(
                    ISNULL(P.OpeningStock, 0)
                    AS DECIMAL(18,3)
                ) AS ProductOpeningStock,

                /*
                    Product_OpeningStock quantity.

                    Important:
                    This may represent the same stock as Product.OpeningStock
                    or Stock_Product, so it must NOT simply be added to them.
                */
                CAST(
                    ISNULL(
                        (
                            SELECT SUM(ISNULL(O.Qty, 0))
                            FROM dbo.Product_OpeningStock O
                            WHERE O.ProductID = P.PID
                        ),
                        0
                    )
                    AS DECIMAL(18,3)
                ) AS ProductOpeningQty,

                /*
                    Stock_Product quantity.

                    Retail Daddy may duplicate the same base quantity in
                    Product.OpeningStock / Product_OpeningStock / Stock_Product.
                    Therefore this is treated as an alternative stock source,
                    not automatically added.
                */
                CAST(
                    ISNULL(
                        (
                            SELECT SUM(ISNULL(SP.Qty, 0))
                            FROM dbo.Stock_Product SP
                            WHERE SP.ProductID = P.PID
                        ),
                        0
                    )
                    AS DECIMAL(18,3)
                ) AS StockProductQty,

                /* Sold Quantity */
                CAST(
                    ISNULL(
                        (
                            SELECT SUM(ISNULL(IP.Qty, 0))
                            FROM dbo.Invoice_Product IP
                            WHERE IP.ProductID = P.PID
                        ),
                        0
                    )
                    AS DECIMAL(18,3)
                ) AS SoldQty,

                /* Sales Return Quantity */
                CAST(
                    ISNULL(
                        (
                            SELECT SUM(ISNULL(SR.Qty, 0))
                            FROM dbo.SalesReturn_Join SR
                            WHERE SR.ProductID = P.PID
                        ),
                        0
                    )
                    AS DECIMAL(18,3)
                ) AS SalesReturnQty

            FROM dbo.Product P

            LEFT JOIN dbo.SubCategory SC
                ON P.SubCategoryID = SC.ID

            ORDER BY P.PID DESC;
        `);

        const products = result.recordset.map(item => {

            const productOpeningStock =
                Number(item.ProductOpeningStock || 0);

            const productOpeningQty =
                Number(item.ProductOpeningQty || 0);

            const stockProductQty =
                Number(item.StockProductQty || 0);

            const soldQty =
                Number(item.SoldQty || 0);

            const salesReturnQty =
                Number(item.SalesReturnQty || 0);

            /*
                ====================================================
                RETAIL DADDY BASE STOCK SOURCE SELECTION
                ====================================================

                IMPORTANT:
                We choose ONE base stock source.

                Retail Daddy can store the same opening/base stock
                in multiple tables. Adding them together would
                duplicate or triple-count the stock.

                Verified examples:

                BMW Plain:
                Product_OpeningStock = 2527.400
                Sold = 283.250
                Available = 2244.150

                OM MIX SUIT:
                Product.OpeningStock = 160
                Product_OpeningStock = 160
                Stock_Product = 160
                Sold = 1
                Available = 159

                GNA JAM ZARKAN:
                Product.OpeningStock = 24
                Stock_Product = 24
                Sold = 5
                Available = 19

                New products:
                Stock_Product Qty - Sold + Return
            */

            let baseStock = 0;
            let baseStockSource = "NONE";

            if (productOpeningQty !== 0) {

                baseStock = productOpeningQty;
                baseStockSource = "Product_OpeningStock";

            } else if (stockProductQty !== 0) {

                baseStock = stockProductQty;
                baseStockSource = "Stock_Product";

            } else {

                baseStock = productOpeningStock;
                baseStockSource = "Product.OpeningStock";
            }

            const availableQty =
                baseStock
                - soldQty
                + salesReturnQty;

            return {

                /*
                    ====================================================
                    WEBSITE-COMPATIBLE FIELDS
                    ====================================================

                    These lowercase fields are required by the
                    existing SR PSD website/index.html.
                */

                name: item.ProductName || "",

                alias: item.ProductCode || "",

                barcode: String(item.Barcode || ""),

                group:
                    item.PartGroup ||
                    item.SubCategory ||
                    item.Category ||
                    "",

                mrp:
                    Number(item.MRP || 0),

                sale:
                    Number(item.SalePrice || 0),

                wholesale:
                    Number(item.WholesalePrice || 0),

                purchase:
                    Number(item.PurchasePrice || 0),

                stock:
                    Number(availableQty.toFixed(3)),

                /*
                    ====================================================
                    ORIGINAL RETAIL DADDY FIELDS
                    ====================================================

                    These are retained so our verified exporter,
                    diagnostics and future development continue
                    to work exactly as before.
                */

                ProductID: item.ProductID,

                ProductCode: item.ProductCode || "",
                ProductName: item.ProductName || "",

                Category: item.Category || "",
                SubCategory: item.SubCategory || "",
                PartGroup: item.PartGroup || "",

                HSNCode: item.HSNCode || "",
                Barcode: item.Barcode || "",

                MRP: Number(item.MRP || 0),
                SalePrice: Number(item.SalePrice || 0),
                WholesalePrice: Number(item.WholesalePrice || 0),
                PurchasePrice: Number(item.PurchasePrice || 0),

                AvailableQty:
                    Number(availableQty.toFixed(3)),

                /*
                    Diagnostic fields.

                    These allow us to identify exactly where
                    a stock mismatch comes from without guessing.
                */

                StockDebug: {

                    BaseStockSource:
                        baseStockSource,

                    BaseStock:
                        Number(baseStock.toFixed(3)),

                    ProductOpeningStock:
                        Number(productOpeningStock.toFixed(3)),

                    ProductOpeningQty:
                        Number(productOpeningQty.toFixed(3)),

                    StockProductQty:
                        Number(stockProductQty.toFixed(3)),

                    SoldQty:
                        Number(soldQty.toFixed(3)),

                    SalesReturnQty:
                        Number(salesReturnQty.toFixed(3))
                }
            };
        });

        /*
            Write items.json
        */

        fs.writeFileSync(
            "items.json",
            JSON.stringify(products, null, 2),
            "utf8"
        );

        /*
            Statistics
        */

        const positiveStock =
            products.filter(p => p.AvailableQty > 0).length;

        const zeroStock =
            products.filter(p => p.AvailableQty === 0).length;

        const negativeStock =
            products.filter(p => p.AvailableQty < 0).length;

        const totalQuantity =
            products.reduce(
                (sum, p) => sum + p.AvailableQty,
                0
            );

        console.log("========================================");
        console.log("EXPORT COMPLETED SUCCESSFULLY");
        console.log("========================================");

        console.log("Total Products :", products.length);
        console.log("Positive Stock :", positiveStock);
        console.log("Zero Stock     :", zeroStock);
        console.log("Negative Stock :", negativeStock);

        console.log(
            "Total Quantity :",
            Number(totalQuantity.toFixed(3))
        );

        console.log("File Created   : items.json");

        /*
            Known-product verification
        */

        const verificationNames = [
            "BMW Plain",
            "OM MIX SUIT",
            "GNA JAM ZARKAN",
            "KF ANITA",
            "KF AYUSHI",
            "AHD DIL",
            "MASTER BLACK BEAUTY",
            "ALIYA JT"
        ];

        console.log("");
        console.log("========================================");
        console.log("KNOWN PRODUCT VERIFICATION");
        console.log("========================================");

        for (const name of verificationNames) {

            const matches = products.filter(
                p =>
                    p.ProductName.toUpperCase() ===
                    name.toUpperCase()
            );

            if (matches.length === 0) {

                console.log("");
                console.log(name, "- NOT FOUND");

                continue;
            }

            for (const p of matches) {

                console.log("");

                console.log(
                    p.ProductName,
                    "| PID:",
                    p.ProductID,
                    "| Barcode:",
                    p.Barcode
                );

                console.log(
                    "Source:",
                    p.StockDebug.BaseStockSource
                );

                console.log(
                    "Base Stock:",
                    p.StockDebug.BaseStock
                );

                console.log(
                    "Product.OpeningStock:",
                    p.StockDebug.ProductOpeningStock
                );

                console.log(
                    "Product_OpeningStock:",
                    p.StockDebug.ProductOpeningQty
                );

                console.log(
                    "Stock_Product:",
                    p.StockDebug.StockProductQty
                );

                console.log(
                    "Sold:",
                    p.StockDebug.SoldQty
                );

                console.log(
                    "Sales Return:",
                    p.StockDebug.SalesReturnQty
                );

                console.log(
                    "AVAILABLE:",
                    p.AvailableQty
                );
            }
        }

        console.log("");
        console.log("========================================");

    } catch (err) {

        console.error("");
        console.error("========================================");
        console.error("EXPORT FAILED");
        console.error("========================================");
        console.error(err);

        process.exitCode = 1;

    } finally {

        if (pool) {

            try {

                await pool.close();
                console.log("Database connection closed.");

            } catch (closeError) {

                console.error(
                    "Error closing database connection:",
                    closeError
                );
            }
        }
    }
}

exportStock();