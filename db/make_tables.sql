-- 1. Products Table
CREATE TABLE products (
  product_id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  brand VARCHAR(255),
  category VARCHAR(255),
  users_subscribed INT DEFAULT 0
);

-- 2. User_Products Junction Table (Unique Pairs)
CREATE TABLE user_products (
  user_id INT NOT NULL,
  product_id INT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, product_id)
);

-- 3. History Table (JSONB for dynamic structure)
CREATE TABLE history (
  product_id INT PRIMARY KEY REFERENCES products(product_id) ON DELETE CASCADE,
  data JSONB NOT NULL
);