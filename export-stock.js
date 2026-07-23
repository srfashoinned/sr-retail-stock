const sql = require("mssql");
const fs = require("fs");
const path = require("path");

const config = require("./config.json");

async function exportStock() {
    let pool;

    try {
        console.log("");
        console.log("==========================================");
        console.log("   SR FASHION - STOCK EXPORT STARTED");
        console.log("==========================================");
        console.log("");

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

                /*
                    CORRECT RETAIL DADDY BARCODE

                    Product.Barcode can contain 0 even when Retail Daddy
                    shows a valid barcode.

                    Priority:
                    1. Latest valid Stock_Product barcode
                    2. Latest valid Product_OpeningStock barcode
                    3. Product.Barcode fallback
                */
                LTRIM(RTRIM(
                    COALESCE(

                        (
                            SELECT TOP 1
                                CONVERT(NVARCHAR(100), SP.Barcode)

                            FROM dbo.Stock_Product SP

                            WHERE
                                SP.ProductID = P.PID

                                AND NULLIF(
                                    LTRIM(RTRIM(
                                        CONVERT(NVARCHAR(100), SP.Barcode)
                                    )),
                                    ''
                                ) IS NOT NULL

                                AND LTRIM(RTRIM(
                                    CONVERT(NVARCHAR(100), SP.Barcode)
                                )) <> '0'

                            ORDER BY SP.SP_ID DESC
                        ),

                        (
                            SELECT TOP 1
                                CONVERT(NVARCHAR(100), O.Barcode)

                            FROM dbo.Product_OpeningStock O

                            WHERE
                                O.ProductID = P.PID

                                AND NULLIF(
                                    LTRIM(RTRIM(
                                        CONVERT(NVARCHAR(100), O.Barcode)
                                    )),
                                    ''
                                ) IS NOT NULL

                                AND LTRIM(RTRIM(
                                    CONVERT(NVARCHAR(100), O.Barcode)
                                )) <> '0'

                            ORDER BY O.ID DESC
                        ),

                        NULLIF(
                            LTRIM(RTRIM(
                                CONVERT(NVARCHAR(100), P.Barcode)
                            )),
                            '0'
                        ),

                        ''
                    )
                )) AS Barcode,

                /*
                    PRODUCT ENTRY DATE

                    Verified against SONY LAXMI A93:
                    ProductID 33557
                    Barcode 4659
                    AddDate 2026-07-18

                    Product.AddDate is the primary source.

                    Product_OpeningStock.PAddDate is used only
                    as a fallback if Product.AddDate is NULL.
                */
                COALESCE(
                    P.AddDate,

                    (
                        SELECT TOP 1 O.PAddDate

                        FROM dbo.Product_OpeningStock O

                        WHERE O.ProductID = P.PID
                          AND O.PAddDate IS NOT NULL

                        ORDER BY O.ID DESC
                    )
                ) AS EntryDate,

                ISNULL(P.MRP, 0) AS MRP,

                ISNULL(
                    P.SellingPrice,
                    0
                ) AS SalePrice,

                /*
                    WHOLESALE PRICE

                    Keep existing Retail Daddy price logic.
                */
                ISNULL(
                    (
                        SELECT TOP 1 O.WSalePrice

                        FROM dbo.Product_OpeningStock O

                        WHERE O.ProductID = P.PID

                        ORDER BY O.ID DESC
                    ),
                    0
                ) AS WholesalePrice,

                /*
                    PURCHASE PRICE

                    Prefer Product_OpeningStock purchase price.
                    Fall back to Product.CostPrice.
                */
                ISNULL(
                    (
                        SELECT TOP 1 O.PPrice

                        FROM dbo.Product_OpeningStock O

                        WHERE O.ProductID = P.PID

                        ORDER BY O.ID DESC
                    ),

                    ISNULL(P.CostPrice, 0)

                ) AS PurchasePrice,

                /*
                    PRODUCT.OPENINGSTOCK
                */
                CAST(
                    ISNULL(
                        P.OpeningStock,
                        0
                    )

                    AS DECIMAL(18,3)

                ) AS ProductOpeningStock,

                /*
                    PRODUCT_OPENINGSTOCK QUANTITY

                    This may represent the same base stock as another
                    stock source, so it is NOT blindly added.
                */
                CAST(
                    ISNULL(
                        (
                            SELECT
                                SUM(ISNULL(O.Qty, 0))

                            FROM dbo.Product_OpeningStock O

                            WHERE O.ProductID = P.PID
                        ),
                        0
                    )

                    AS DECIMAL(18,3)

                ) AS ProductOpeningQty,

                /*
                    STOCK_PRODUCT QUANTITY

                    Retail Daddy may duplicate base quantity between:
                    Product.OpeningStock
                    Product_OpeningStock
                    Stock_Product

                    We therefore treat them as alternative base-stock
                    sources rather than adding all three together.
                */
                CAST(
                    ISNULL(
                        (
                            SELECT
                                SUM(ISNULL(SP.Qty, 0))

                            FROM dbo.Stock_Product SP

                            WHERE SP.ProductID = P.PID
                        ),
                        0
                    )

                    AS DECIMAL(18,3)

                ) AS StockProductQty,

                /*
                    SOLD QUANTITY
                */
                CAST(
                    ISNULL(
                        (
                            SELECT
                                SUM(ISNULL(IP.Qty, 0))

                            FROM dbo.Invoice_Product IP

                            WHERE IP.ProductID = P.PID
                        ),
                        0
                    )

                    AS DECIMAL(18,3)

                ) AS SoldQty,

                /*
                    SALES RETURN QUANTITY
                */
                CAST(
                    ISNULL(
                        (
                            SELECT
                                SUM(ISNULL(SR.Qty, 0))

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

            /*
                =====================================================
                EXISTING STOCK PIPELINE
                =====================================================

                Retail Daddy can store the same base quantity in:

                - Product.OpeningStock
                - Product_OpeningStock
                - Stock_Product

                These must NOT simply be added together.

                Priority:
                Stock_Product
                -> Product_OpeningStock
                -> Product.OpeningStock

                Then sales and sales returns are applied only when
                the selected source represents base stock rather than
                an already-current stock figure.
            */

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

            let baseStock = 0;
            let baseStockSource = "None";

            /*
                Prefer Stock_Product when it contains stock.

                This is the source that correctly contains
                SONY LAXMI A93 barcode 4659 and quantity 4.
            */
            if (stockProductQty !== 0) {

                baseStock = stockProductQty;
                baseStockSource = "Stock_Product";

            } else if (productOpeningQty !== 0) {

                baseStock = productOpeningQty;
                baseStockSource = "Product_OpeningStock";

            } else {

                baseStock = productOpeningStock;
                baseStockSource = "Product.OpeningStock";
            }

            /*
                Preserve the stock behaviour used by the current
                working exporter.

                Stock_Product is treated as current/base stock
                according to the existing Retail Daddy mapping.

                For fallback opening-stock sources, subtract sales
                and add sales returns.
            */

            let availableQty;

            if (baseStockSource === "Stock_Product") {

                availableQty = baseStock;

            } else {

                availableQty =
                    baseStock
                    - soldQty
                    + salesReturnQty;
            }

            /*
                Avoid floating-point noise.
            */
            availableQty =
                Math.round(
                    (availableQty + Number.EPSILON) * 1000
                ) / 1000;

            /*
                ENTRY DATE

                Convert SQL datetime into simple YYYY-MM-DD
                for fast website filtering.

                Example:
                2026-07-18
            */
            let entryDate = "";

            if (item.EntryDate) {

                const date = new Date(item.EntryDate);

                if (!isNaN(date.getTime())) {

                    entryDate =
                        date.getFullYear()
                        + "-"
                        + String(date.getMonth() + 1).padStart(2, "0")
                        + "-"
                        + String(date.getDate()).padStart(2, "0");
                }
            }

            /*
                =====================================================
                CLEAN WEBSITE JSON
                =====================================================

                No HSN.

                No duplicate uppercase/lowercase copies.

                No StockDebug payload.

                Keep fields needed by the website:
                name
                alias
                barcode
                group
                Category
                SubCategory
                PartGroup
                mrp
                sale
                wholesale
                purchase
                stock
                entryDate

                ProductID is retained as a lightweight stable
                identifier because it is useful internally.
            */

            return {

                ProductID:
                    Number(item.ProductID || 0),

                name:
                    item.ProductName || "",

                alias:
                    item.ProductCode || "",

                barcode:
                    String(item.Barcode || "").trim(),

                group:
                    item.PartGroup
                    || item.SubCategory
                    || item.Category
                    || "GENERAL",

                Category:
                    item.Category || "",

                SubCategory:
                    item.SubCategory || "",

                PartGroup:
                    item.PartGroup || "",

                mrp:
                    Number(item.MRP || 0),

                sale:
                    Number(item.SalePrice || 0),

                wholesale:
                    Number(item.WholesalePrice || 0),

                purchase:
                    Number(item.PurchasePrice || 0),

                stock:
                    availableQty,

                entryDate:
                    entryDate
            };
        });

        /*
            Remove completely empty product rows only.

            Do NOT remove zero-stock products because the website
            needs Out of Stock filtering.
        */
        const cleanProducts = products.filter(product => {

            return (
                product.ProductID
                || product.name
                || product.alias
                || product.barcode
            );
        });

        const outputPath =
            path.join(
                __dirname,
                "items.json"
            );

        fs.writeFileSync(
            outputPath,
            JSON.stringify(
                cleanProducts,
                null,
                2
            ),
            "utf8"
        );

        console.log("");
        console.log("==========================================");
        console.log("        EXPORT COMPLETED SUCCESSFULLY");
        console.log("==========================================");

        console.log(
            "Products exported:",
            cleanProducts.length
        );

        console.log(
            "Output:",
            outputPath
        );

        /*
            Verification for the known barcode issue.
        */
        const sony = cleanProducts.find(product =>

            Number(product.ProductID) === 33557

            || String(product.name)
                .toUpperCase()
                .includes("SONY LAXMI A93")
        );

        if (sony) {

            console.log("");
            console.log("BARCODE / DATE TEST PRODUCT:");
            console.log("----------------------------");

            console.log(
                "Name:",
                sony.name
            );

            console.log(
                "ProductID:",
                sony.ProductID
            );

            console.log(
                "Barcode:",
                sony.barcode
            );

            console.log(
                "Entry Date:",
                sony.entryDate
            );

            console.log(
                "Stock:",
                sony.stock
            );

            console.log("");

            if (sony.barcode === "4659") {

                console.log(
                    "BARCODE TEST PASSED: 4659"
                );

            } else {

                console.warn(
                    "WARNING: Expected barcode 4659 but got:",
                    sony.barcode
                );
            }

        } else {

            console.warn(
                "SONY LAXMI A93 / ProductID 33557 was not found."
            );
        }

        console.log("");

    } catch (error) {

        console.error("");
        console.error("==========================================");
        console.error("             EXPORT FAILED");
        console.error("==========================================");

        console.error(
            error
        );

        process.exitCode = 1;

    } finally {

        try {

            if (pool) {

                await pool.close();
            }

        } catch (closeError) {

            console.error(
                "Database close error:",
                closeError.message
            );
        }
    }
}

exportStock();